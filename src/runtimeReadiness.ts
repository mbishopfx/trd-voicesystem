import { config, resolvedBookingUrl } from "./config.js";
import { isGhlConfigured } from "./integrations/ghl.js";
import { isTwilioSmsConfigured } from "./integrations/twilioSms.js";
import type { RuntimeLogEntry } from "./runtimeLogs.js";
import type { Lead } from "./types.js";

export interface OperationalInsight {
  level: "blocker" | "warning" | "opportunity";
  title: string;
  detail: string;
}

export interface OperationsSnapshot {
  score: number;
  blockers: string[];
  warnings: string[];
  insights: OperationalInsight[];
  metrics: {
    totalLeads: number;
    attemptedLeads: number;
    blockedLeads: number;
    failedLeads: number;
    recentErrorCount: number;
    recentRestartCount: number;
  };
}

export interface RecommendedAction {
  priority: "high" | "medium" | "low";
  area: "dialer" | "scheduler" | "prospector" | "integrations" | "runtime";
  title: string;
  detail: string;
}

export interface OperationalLogFingerprint {
  key: string;
  level: "info" | "error";
  scope: RuntimeLogEntry["scope"];
  count: number;
  lastSeenAt: string;
  sample: string;
}

export interface LeadErrorFingerprint {
  key: string;
  count: number;
  lastSeenAt: string;
  sample: string;
  statuses: string[];
  campaigns: string[];
}

export interface ProspectorQueueAging {
  totalProspects: number;
  blockedProspects: number;
  readyForReview: number;
  readyForCall: number;
  oldestBlockedDays: number;
  oldestReadyForReviewDays: number;
  blockedOver3Days: number;
  blockedOver7Days: number;
  readyForReviewOver3Days: number;
}

export interface FeatureRecommendation {
  priority: "high" | "medium" | "low";
  title: string;
  summary: string;
  rationale: string;
  impact: string;
}

export interface OptimizationBacklogItem {
  priority: "high" | "medium" | "low";
  lane: "operator" | "hardening" | "feature";
  owner: "ops" | "engineering" | "growth";
  title: string;
  summary: string;
  evidence: string;
  nextStep: string;
}

export interface RuntimeWatchdogReport {
  status: "healthy" | "warning" | "critical";
  summary: string;
  blockers: string[];
  topSignals: Array<{
    label: string;
    value: string;
    tone: "critical" | "warning" | "info";
  }>;
  restartBuckets: Array<{
    label: string;
    count: number;
  }>;
  failureBuckets: Array<{
    title: string;
    count: number;
    detail: string;
  }>;
}

function hasAssistantConfig(): boolean {
  return Boolean(
    config.vapiAssistantId || config.vapiAssistantIdFemale || config.vapiAssistantIdMale || config.vapiProspectorAssistantId
  );
}

function hasPhoneConfig(): boolean {
  if (config.vapiPhoneNumberId) return true;
  return Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioPhoneNumber);
}

function normalizeLogMessage(message: string): string {
  return String(message || "")
    .replace(/\{.*\}$/g, "")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b\d{4,}\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function normalizeLeadErrorMessage(message: string): string {
  return String(message || "")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b[a-f0-9]{12,}\b/gi, "#")
    .replace(/\b\d{4,}\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function ageInDays(iso: string | undefined, now = Date.now()): number {
  const ts = Date.parse(String(iso || ""));
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.floor((now - ts) / (24 * 60 * 60 * 1000)));
}

export function getDialerBlockingReasons(): string[] {
  const reasons: string[] = [];
  if (!config.vapiApiKey) reasons.push("Missing VAPI_API_KEY.");
  if (!hasAssistantConfig()) reasons.push("Missing Vapi assistant configuration.");
  if (!hasPhoneConfig()) reasons.push("Missing Vapi phone number or Twilio fallback configuration.");
  return reasons;
}

export function getBulkSchedulerBlockingReasons(): string[] {
  const reasons: string[] = [];
  if (!isGhlConfigured()) reasons.push("Bulk scheduler requires GoHighLevel connection.");
  return reasons;
}

export function buildOperationsSnapshot(leads: Lead[], logs: RuntimeLogEntry[]): OperationsSnapshot {
  const now = Date.now();
  const attemptedLeads = leads.filter(
    (lead) => (lead.attempts || 0) > 0 || Boolean(lead.callAttemptedAt) || Boolean(lead.callId)
  ).length;
  const blockedLeads = leads.filter((lead) => lead.status === "blocked").length;
  const failedLeads = leads.filter((lead) => lead.status === "failed").length;
  const recentErrors = logs.filter((entry) => entry.level === "error" && now - entry.ts <= 24 * 60 * 60 * 1000);
  const recentRestarts = logs.filter(
    (entry) =>
      entry.scope === "server" &&
      entry.message.startsWith("Listening on :") &&
      now - entry.ts <= 6 * 60 * 60 * 1000
  );

  const blockers = [...getDialerBlockingReasons()];
  const warnings: string[] = [];
  if (config.bulkSchedulerEnabled && getBulkSchedulerBlockingReasons().length > 0) {
    blockers.push(...getBulkSchedulerBlockingReasons());
  }
  if (config.winSmsEnabled && (!isTwilioSmsConfigured() || !resolvedBookingUrl())) {
    warnings.push("Win SMS is enabled but Twilio or booking URL setup is incomplete.");
  }
  if (config.smsReplyScanEnabled && !isTwilioSmsConfigured()) {
    warnings.push("SMS reply scanning is enabled but Twilio SMS is not configured.");
  }
  if (recentRestarts.length >= 3) {
    warnings.push(`Detected ${recentRestarts.length} server restarts in the last 6 hours.`);
  }

  const insights: OperationalInsight[] = [];
  const failedMissingVapi = leads.filter((lead) => String(lead.lastError || "").includes("Missing Vapi API key")).length;
  if (failedMissingVapi > 0) {
    insights.push({
      level: "blocker",
      title: "Dial attempts are being consumed without Vapi auth",
      detail: `${failedMissingVapi} leads already failed due to missing Vapi credentials.`
    });
  }
  if (config.bulkSchedulerEnabled && !isGhlConfigured()) {
    insights.push({
      level: "blocker",
      title: "Bulk scheduler is enabled without GHL access",
      detail: "Scheduled campaign runs will not fetch contacts until GoHighLevel credentials are configured."
    });
  }
  if (blockedLeads > 0) {
    insights.push({
      level: "opportunity",
      title: "Prospector approval queue is building up",
      detail: `${blockedLeads} leads are blocked, which is a good fit for an approval + release workflow in the dashboard.`
    });
  }
  if (attemptedLeads === 0 && leads.length > 0) {
    insights.push({
      level: "warning",
      title: "Analytics quality is limited by missing live call data",
      detail: "There are leads in state, but no completed call outcomes yet, so funnel metrics are not representative."
    });
  }
  if (recentErrors.length > 0) {
    insights.push({
      level: "warning",
      title: "Recent runtime errors need triage",
      detail: `${recentErrors.length} error log entries were recorded in the last 24 hours.`
    });
  }

  const score = Math.max(0, 100 - blockers.length * 25 - warnings.length * 10);

  return {
    score,
    blockers,
    warnings,
    insights: insights.slice(0, 6),
    metrics: {
      totalLeads: leads.length,
      attemptedLeads,
      blockedLeads,
      failedLeads,
      recentErrorCount: recentErrors.length,
      recentRestartCount: recentRestarts.length
    }
  };
}

export function buildRecommendedActions(leads: Lead[], logs: RuntimeLogEntry[]): RecommendedAction[] {
  const actions: RecommendedAction[] = [];
  const recentWindowMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const recentErrors = logs.filter((entry) => entry.level === "error" && now - entry.ts <= recentWindowMs);
  const missingVapiFailures = leads.filter((lead) =>
    String(lead.lastError || "").toLowerCase().includes("missing vapi api key")
  ).length;
  const blockedProspects = leads.filter((lead) => lead.status === "blocked" && lead.sourceFile === "prospector-dashboard").length;
  const generatedNotDeployed = leads.filter((lead) => lead.generatedSitePath && !lead.deployedSiteUrl).length;
  const readyForReview = leads.filter((lead) => lead.handoffStatus === "ready_for_review").length;
  const deployedWithoutScript = leads.filter(
    (lead) => lead.sourceFile === "prospector-dashboard" && lead.deployedSiteUrl && !lead.prospectorVoiceScript
  ).length;
  const ghlErrors = leads.filter((lead) => Boolean(lead.ghlLastError)).length;
  const restartCount = logs.filter(
    (entry) =>
      entry.scope === "server" &&
      entry.message.startsWith("Listening on :") &&
      now - entry.ts <= 6 * 60 * 60 * 1000
  ).length;

  if (!config.vapiApiKey || missingVapiFailures > 0) {
    actions.push({
      priority: "high",
      area: "dialer",
      title: "Fix Vapi credentials before any further dialing",
      detail: `${missingVapiFailures} leads already carry missing-key failures and the dialer cannot create calls without VAPI_API_KEY.`
    });
  }

  if (config.bulkSchedulerEnabled && !isGhlConfigured()) {
    actions.push({
      priority: "high",
      area: "scheduler",
      title: "Disable or wire up the bulk scheduler",
      detail: "Bulk scheduling is enabled but GoHighLevel is not configured, so scheduled runs will keep failing."
    });
  }

  if (blockedProspects > 0) {
    actions.push({
      priority: blockedProspects >= 10 ? "high" : "medium",
      area: "prospector",
      title: "Work down the blocked prospector backlog",
      detail: `${blockedProspects} prospector leads are blocked and waiting for review or release into the outreach flow.`
    });
  }

  if (generatedNotDeployed > 0) {
    actions.push({
      priority: "medium",
      area: "prospector",
      title: "Deploy generated prospect sites that are still local only",
      detail: `${generatedNotDeployed} generated sites exist on disk without a deployed URL, which stalls the vision-to-call workflow.`
    });
  }

  if (readyForReview > 0 || deployedWithoutScript > 0) {
    actions.push({
      priority: "medium",
      area: "prospector",
      title: "Finish voice scripting for deployed prospect demos",
      detail: `${readyForReview} leads are marked ready for review and ${deployedWithoutScript} deployed prospects still lack a voice script.`
    });
  }

  if (ghlErrors > 0) {
    actions.push({
      priority: "medium",
      area: "integrations",
      title: "Clear CRM sync failures before scaling campaigns",
      detail: `${ghlErrors} leads carry GoHighLevel sync errors, which weakens attribution and follow-up automation.`
    });
  }

  if (restartCount >= 3) {
    actions.push({
      priority: "medium",
      area: "runtime",
      title: "Investigate repeated server restarts",
      detail: `${restartCount} server start events landed in the last 6 hours, which suggests an unstable local or hosted runtime.`
    });
  }

  if (recentErrors.length > 0) {
    actions.push({
      priority: "low",
      area: "runtime",
      title: "Triage the latest runtime error fingerprints",
      detail: `${recentErrors.length} error log entries were recorded in the last 24 hours and should be grouped into root-cause buckets.`
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return actions
    .sort((a, b) => order[a.priority] - order[b.priority] || a.title.localeCompare(b.title))
    .slice(0, 8);
}

export function buildLogFingerprints(logs: RuntimeLogEntry[], maxItems = 6): OperationalLogFingerprint[] {
  const grouped = new Map<string, OperationalLogFingerprint>();

  for (const entry of logs) {
    const normalized = normalizeLogMessage(entry.message);
    if (!normalized) continue;

    const key = `${entry.level}:${entry.scope}:${normalized}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      if (entry.at > existing.lastSeenAt) {
        existing.lastSeenAt = entry.at;
        existing.sample = entry.message;
      }
      continue;
    }

    grouped.set(key, {
      key,
      level: entry.level,
      scope: entry.scope,
      count: 1,
      lastSeenAt: entry.at,
      sample: entry.message
    });
  }

  return [...grouped.values()]
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    })
    .slice(0, Math.max(1, maxItems));
}

export function buildLeadErrorFingerprints(leads: Lead[], maxItems = 6): LeadErrorFingerprint[] {
  const grouped = new Map<string, LeadErrorFingerprint>();

  for (const lead of leads) {
    const normalized = normalizeLeadErrorMessage(lead.lastError || "");
    if (!normalized) continue;

    const existing = grouped.get(normalized);
    if (existing) {
      existing.count += 1;
      if ((lead.updatedAt || "") > existing.lastSeenAt) {
        existing.lastSeenAt = lead.updatedAt || existing.lastSeenAt;
        existing.sample = lead.lastError || existing.sample;
      }
      if (lead.status && !existing.statuses.includes(lead.status)) existing.statuses.push(lead.status);
      if (lead.campaign && !existing.campaigns.includes(lead.campaign)) existing.campaigns.push(lead.campaign);
      continue;
    }

    grouped.set(normalized, {
      key: normalized,
      count: 1,
      lastSeenAt: lead.updatedAt || lead.createdAt || "",
      sample: lead.lastError || normalized,
      statuses: lead.status ? [lead.status] : [],
      campaigns: lead.campaign ? [lead.campaign] : []
    });
  }

  return [...grouped.values()]
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    })
    .slice(0, Math.max(1, maxItems));
}

export function buildProspectorQueueAging(leads: Lead[]): ProspectorQueueAging {
  const now = Date.now();
  const prospects = leads.filter((lead) => lead.sourceFile === "prospector-dashboard");
  const blocked = prospects.filter((lead) => lead.status === "blocked");
  const readyForReview = prospects.filter((lead) => lead.handoffStatus === "ready_for_review");
  const readyForCall = prospects.filter((lead) => lead.handoffStatus === "ready_for_call");

  const blockedAges = blocked.map((lead) => ageInDays(lead.updatedAt || lead.createdAt, now));
  const reviewAges = readyForReview.map((lead) => ageInDays(lead.updatedAt || lead.createdAt, now));

  return {
    totalProspects: prospects.length,
    blockedProspects: blocked.length,
    readyForReview: readyForReview.length,
    readyForCall: readyForCall.length,
    oldestBlockedDays: blockedAges.length > 0 ? Math.max(...blockedAges) : 0,
    oldestReadyForReviewDays: reviewAges.length > 0 ? Math.max(...reviewAges) : 0,
    blockedOver3Days: blockedAges.filter((days) => days >= 3).length,
    blockedOver7Days: blockedAges.filter((days) => days >= 7).length,
    readyForReviewOver3Days: reviewAges.filter((days) => days >= 3).length
  };
}

export function buildFeatureRecommendations(leads: Lead[], logs: RuntimeLogEntry[]): FeatureRecommendation[] {
  const blockedProspects = leads.filter((lead) => lead.status === "blocked" && lead.sourceFile === "prospector-dashboard").length;
  const reviewReady = leads.filter((lead) => lead.handoffStatus === "ready_for_review").length;
  const queueAging = buildProspectorQueueAging(leads);
  const deployedWithoutScript = leads.filter(
    (lead) => lead.sourceFile === "prospector-dashboard" && lead.deployedSiteUrl && !lead.prospectorVoiceScript
  ).length;
  const restartCount = logs.filter((entry) => entry.scope === "server" && entry.message.startsWith("Listening on :")).length;
  const missingVapiFailures = leads.filter((lead) =>
    String(lead.lastError || "").toLowerCase().includes("missing vapi api key")
  ).length;

  const recommendations: FeatureRecommendation[] = [];

  if (blockedProspects > 0 || reviewReady > 0) {
    recommendations.push({
      priority: blockedProspects >= 10 ? "high" : "medium",
      title: "Prospector release inbox",
      summary: "Add a queue-first review screen with bulk approve, reject, and auto-dial release controls.",
      rationale: `${blockedProspects} blocked prospector leads and ${reviewReady} review-ready records are accumulating in state with no dedicated release workflow.`,
      impact: "Turns the current manual backlog into a controlled throughput step and makes the prospector pipeline easier to scale."
    });
  }

  if (deployedWithoutScript > 0) {
    recommendations.push({
      priority: "medium",
      title: "Post-deploy script autopilot",
      summary: "Auto-generate or flag missing prospect voice scripts immediately after a successful deploy.",
      rationale: `${deployedWithoutScript} deployed prospect pages are missing a voice script, which breaks the handoff from phase 2 to phase 5.`,
      impact: "Reduces phase gaps and keeps generated demos moving into outbound calling without operator babysitting."
    });
  }

  if (queueAging.blockedOver7Days > 0 || queueAging.readyForReviewOver3Days > 0) {
    recommendations.push({
      priority: queueAging.blockedOver7Days >= 5 ? "high" : "medium",
      title: "Prospector queue SLA watchdog",
      summary: "Escalate stale blocked and review-ready prospects before they die in the queue.",
      rationale: `${queueAging.blockedOver7Days} blocked prospects are older than 7 days and ${queueAging.readyForReviewOver3Days} review-ready prospects have been sitting for more than 3 days.`,
      impact: "Protects prospecting throughput by turning hidden backlog age into an explicit release and follow-up workflow."
    });
  }

  if (restartCount >= 3 || missingVapiFailures > 0) {
    recommendations.push({
      priority: restartCount >= 3 ? "medium" : "low",
      title: "Runtime watchdog timeline",
      summary: "Track restart streaks, config blockers, and repeated dialer failures in a single operator panel.",
      rationale: `${restartCount} restart events and ${missingVapiFailures} credential-related failures show that the current logs surface symptoms, but not stable root-cause grouping.`,
      impact: "Improves operational debugging and helps prevent repeated failed dial attempts when the runtime is misconfigured."
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return recommendations.sort((a, b) => order[a.priority] - order[b.priority] || a.title.localeCompare(b.title)).slice(0, 3);
}

export function buildOptimizationBacklog(leads: Lead[], logs: RuntimeLogEntry[]): OptimizationBacklogItem[] {
  const queueAging = buildProspectorQueueAging(leads);
  const dialerBlockers = getDialerBlockingReasons();
  const bulkSchedulerBlockers = config.bulkSchedulerEnabled ? getBulkSchedulerBlockingReasons() : [];
  const missingVapiFailures = leads.filter((lead) =>
    String(lead.lastError || "").toLowerCase().includes("missing vapi api key")
  ).length;
  const ghlErrors = leads.filter((lead) => Boolean(lead.ghlLastError)).length;
  const deployedWithoutScript = leads.filter(
    (lead) => lead.sourceFile === "prospector-dashboard" && lead.deployedSiteUrl && !lead.prospectorVoiceScript
  ).length;
  const generatedNotDeployed = leads.filter(
    (lead) => lead.sourceFile === "prospector-dashboard" && lead.generatedSitePath && !lead.deployedSiteUrl
  ).length;
  const restartCount = logs.filter((entry) => entry.scope === "server" && entry.message.startsWith("Listening on :")).length;

  const backlog: OptimizationBacklogItem[] = [];

  if (dialerBlockers.length > 0 || missingVapiFailures > 0) {
    backlog.push({
      priority: "high",
      lane: "operator",
      owner: "ops",
      title: "Restore live dialing prerequisites",
      summary: "The call path is still blocked by missing runtime config, so funnel analytics are mostly synthetic.",
      evidence: `${dialerBlockers.length} active dialer blockers and ${missingVapiFailures} credential-related lead failures are present in local state.`,
      nextStep: "Set VAPI_API_KEY plus assistant and phone config, then re-run a controlled smoke batch before scaling."
    });
  }

  if (queueAging.blockedOver7Days > 0 || queueAging.readyForReviewOver3Days > 0) {
    backlog.push({
      priority: queueAging.blockedOver7Days >= 10 ? "high" : "medium",
      lane: "operator",
      owner: "ops",
      title: "Burn down the stale prospector queue",
      summary: "Prospector output is piling up faster than it is being reviewed or released into dialing.",
      evidence: `${queueAging.blockedProspects} prospects are blocked, ${queueAging.blockedOver7Days} are older than 7 days, and ${queueAging.readyForReviewOver3Days} review-ready items are stale.`,
      nextStep: "Work the review queue in priority order, bulk-release items that already have assets, and reject dead prospects instead of leaving them blocked."
    });
  }

  if (ghlErrors > 0 || bulkSchedulerBlockers.length > 0) {
    backlog.push({
      priority: bulkSchedulerBlockers.length > 0 ? "high" : "medium",
      lane: "operator",
      owner: "ops",
      title: "Repair CRM sync before more automation",
      summary: "Scheduler and attribution quality degrade when CRM writes are failing or disabled.",
      evidence: `${ghlErrors} leads have GHL sync errors${bulkSchedulerBlockers.length ? ` and ${bulkSchedulerBlockers.length} scheduler blockers are active` : ""}.`,
      nextStep: "Fix GHL credentials and re-run sync on failed records before enabling higher-volume scheduled outreach."
    });
  }

  if (restartCount >= 10) {
    backlog.push({
      priority: "medium",
      lane: "hardening",
      owner: "engineering",
      title: "Investigate repeated runtime cold starts",
      summary: "The service has restarted often enough that operator state and timing assumptions may not be reliable.",
      evidence: `${restartCount} retained server start events were recorded, with visible restart clusters across multiple dates and ports.`,
      nextStep: "Check hosting health, process supervision, and boot-time failures; keep the watchdog panel focused on restart streaks until the pattern stabilizes."
    });
  }

  if (generatedNotDeployed > 0 || deployedWithoutScript > 0) {
    backlog.push({
      priority: "medium",
      lane: "hardening",
      owner: "engineering",
      title: "Close prospector handoff gaps automatically",
      summary: "Generated prospects still fall out of the pipeline between deploy, scripting, and release.",
      evidence: `${generatedNotDeployed} generated prospect sites are not deployed and ${deployedWithoutScript} deployed prospects still lack a voice script.`,
      nextStep: "Add post-phase checks that auto-queue missing deploy/script work instead of relying on manual spotting."
    });
  }

  backlog.push({
    priority: "medium",
    lane: "feature",
    owner: "growth",
    title: "Ship an intervention board for prospector throughput",
    summary: "The existing review and watchdog data is enough to drive a queue-first operator workflow.",
    evidence: "The platform already tracks blockers, review status, deploy state, scripts, CRM sync, and restart/error fingerprints in one place.",
    nextStep: "Promote the analytics backlog into a dedicated intervention board with assignees, SLA aging, and one-click bulk actions."
  });

  const order = { high: 0, medium: 1, low: 2 };
  return backlog
    .sort((a, b) => order[a.priority] - order[b.priority] || a.title.localeCompare(b.title))
    .slice(0, 6);
}

export function buildRuntimeWatchdog(leads: Lead[], logs: RuntimeLogEntry[]): RuntimeWatchdogReport {
  const dialerBlockers = getDialerBlockingReasons();
  const bulkSchedulerBlockers = config.bulkSchedulerEnabled ? getBulkSchedulerBlockingReasons() : [];
  const queueAging = buildProspectorQueueAging(leads);
  const missingVapiFailures = leads.filter((lead) =>
    String(lead.lastError || "").toLowerCase().includes("missing vapi api key")
  ).length;
  const ghlErrors = leads.filter((lead) => Boolean(lead.ghlLastError)).length;
  const reviewReady = leads.filter((lead) => lead.handoffStatus === "ready_for_review").length;
  const restartBucketsMap = new Map<string, number>();
  const restartEvents = logs.filter((entry) => entry.scope === "server" && entry.message.startsWith("Listening on :"));
  for (const entry of restartEvents) {
    const label = String(entry.at || "").slice(0, 10) || "unknown";
    restartBucketsMap.set(label, (restartBucketsMap.get(label) || 0) + 1);
  }

  const restartBuckets = [...restartBucketsMap.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(-7);

  const leadFailures = buildLeadErrorFingerprints(leads, 3).map((item) => ({
    title: item.sample || item.key,
    count: item.count,
    detail: item.campaigns.length ? `Campaigns: ${item.campaigns.join(", ")}` : "Lead error fingerprint"
  }));
  const logFailures = buildLogFingerprints(
    logs.filter((entry) => entry.level === "error"),
    3
  ).map((item) => ({
    title: item.sample || item.key,
    count: item.count,
    detail: `${item.scope} runtime error`
  }));
  const failureBuckets = [...leadFailures, ...logFailures]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, 5);

  const blockers = [...dialerBlockers, ...bulkSchedulerBlockers];
  const topSignals: RuntimeWatchdogReport["topSignals"] = [
    {
      label: "Dialer blockers",
      value: blockers.length ? `${blockers.length} active` : "0 active",
      tone: blockers.length ? "critical" : "info"
    },
    {
      label: "Missing-Vapi failures",
      value: String(missingVapiFailures),
      tone: missingVapiFailures > 0 ? "critical" : "info"
    },
    {
      label: "GHL sync errors",
      value: String(ghlErrors),
      tone: ghlErrors > 0 ? "warning" : "info"
    },
    {
      label: "Review backlog",
      value: `${reviewReady} ready / ${queueAging.blockedProspects} blocked`,
      tone: queueAging.blockedProspects > 0 || reviewReady > 0 ? "warning" : "info"
    },
    {
      label: "Stale prospects",
      value: `${queueAging.blockedOver7Days} >7d`,
      tone: queueAging.blockedOver7Days > 0 ? "warning" : "info"
    }
  ];

  const status: RuntimeWatchdogReport["status"] = blockers.length > 0 || missingVapiFailures > 0
    ? "critical"
    : ghlErrors > 0 || queueAging.blockedOver7Days > 0 || restartEvents.length >= 3
    ? "warning"
    : "healthy";

  const summary =
    status === "critical"
      ? `Critical blockers detected: ${blockers[0] || "repeated dial failures are consuming leads before live calling is configured."}`
      : status === "warning"
      ? `Watch runtime drift: ${ghlErrors} CRM sync issues, ${queueAging.blockedOver7Days} stale prospects over 7 days, ${restartEvents.length} recorded restarts.`
      : "No critical runtime blockers detected in local state and log history.";

  return {
    status,
    summary,
    blockers,
    topSignals,
    restartBuckets,
    failureBuckets
  };
}
