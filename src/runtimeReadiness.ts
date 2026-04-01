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

function hasAssistantConfig(): boolean {
  return Boolean(
    config.vapiAssistantId || config.vapiAssistantIdFemale || config.vapiAssistantIdMale || config.vapiProspectorAssistantId
  );
}

function hasPhoneConfig(): boolean {
  if (config.vapiPhoneNumberId) return true;
  return Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioPhoneNumber);
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
