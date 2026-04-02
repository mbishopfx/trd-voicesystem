import { config, resolvedBookingUrl } from "./config.js";
import { compactTags, logLeadNoteToGhl } from "./integrations/ghl.js";
import { isTwilioSmsConfigured, sendSmsMessage } from "./integrations/twilioSms.js";
import { runtimeError, runtimeInfo } from "./runtimeLogs.js";
import { withState } from "./store.js";
import type { BdcTouch, Lead } from "./types.js";
import { hashShort, nowIso } from "./utils.js";

const WORKFLOW_VERSION = "trd-bdc-v1";
const MAX_RUN_ACTIONS = 12;
const RECENT_SMS_SUPPRESSION_MS = 12 * 60 * 60 * 1000;
const RECENT_CALL_SUPPRESSION_MS = 8 * 60 * 60 * 1000;

type BdcTemplate = {
  dayOffset: number;
  minuteOffset?: number;
  channel: BdcTouch["channel"];
  templateKey: string;
};

const DEFAULT_TOUCH_PLAN: BdcTemplate[] = [
  { dayOffset: 0, minuteOffset: 5, channel: "sms", templateKey: "day1-sms" },
  { dayOffset: 0, minuteOffset: 15, channel: "email", templateKey: "day1-email" },
  { dayOffset: 2, channel: "sms", templateKey: "day2-sms" },
  { dayOffset: 3, channel: "email", templateKey: "day3-email" },
  { dayOffset: 5, channel: "call", templateKey: "day5-call" },
  { dayOffset: 7, channel: "sms", templateKey: "day7-sms" },
  { dayOffset: 14, channel: "sms", templateKey: "day14-sms" },
  { dayOffset: 17, channel: "email", templateKey: "day17-email" },
  { dayOffset: 21, channel: "call", templateKey: "day21-call" },
  { dayOffset: 28, channel: "email", templateKey: "day28-email" },
  { dayOffset: 35, channel: "sms", templateKey: "day35-sms" },
  { dayOffset: 45, channel: "call", templateKey: "day45-call" },
  { dayOffset: 52, channel: "email", templateKey: "day52-email" },
  { dayOffset: 60, channel: "sms", templateKey: "day60-sms" },
  { dayOffset: 75, channel: "email", templateKey: "day75-email" },
  { dayOffset: 90, channel: "sms", templateKey: "day90-sms" }
];

function addOffset(baseIso: string, dayOffset: number, minuteOffset = 0): string {
  const ts = Date.parse(baseIso || nowIso());
  const base = Number.isFinite(ts) ? ts : Date.now();
  return new Date(base + dayOffset * 86400000 + minuteOffset * 60000).toISOString();
}

function bookingUrlForLead(lead: Lead): string {
  return lead.bookingUrlOverride || resolvedBookingUrl() || config.bookingUrlCalendly || "";
}

function leadDisplayCompany(lead: Lead): string {
  return lead.company || "your business";
}

function leadGreeting(lead: Lead): string {
  return lead.firstName ? `Hi ${lead.firstName},` : "Hi,";
}

function pushUniqueTouches(existing: BdcTouch[], createdAt: string): BdcTouch[] {
  const map = new Map(existing.map((touch) => [`${touch.channel}:${touch.templateKey}`, touch]));
  for (const step of DEFAULT_TOUCH_PLAN) {
    const key = `${step.channel}:${step.templateKey}`;
    if (map.has(key)) continue;
    const dueAt = addOffset(createdAt, step.dayOffset, step.minuteOffset || 0);
    map.set(key, {
      id: `bdc-${hashShort(`${key}|${createdAt}|${dueAt}`)}`,
      channel: step.channel,
      templateKey: step.templateKey,
      dueAt,
      status: "pending",
      dayOffset: step.dayOffset,
      sequence: step.dayOffset * 1000 + (step.minuteOffset || 0)
    });
  }
  return [...map.values()].sort((a, b) => {
    const aTs = Date.parse(a.dueAt || "");
    const bTs = Date.parse(b.dueAt || "");
    return (Number.isFinite(aTs) ? aTs : 0) - (Number.isFinite(bTs) ? bTs : 0);
  });
}

function nextPendingTouchAt(touches: BdcTouch[]): string | undefined {
  const pending = touches
    .filter((touch) => touch.status === "pending")
    .sort((a, b) => Date.parse(a.dueAt || "") - Date.parse(b.dueAt || ""));
  return pending[0]?.dueAt;
}

function shouldEnableWorkflow(lead: Lead): boolean {
  if (lead.dnc || !lead.optIn) return false;
  if (lead.sourceFile === "prospector-dashboard") return false;
  if (lead.sourceFile === "manual-dashboard") return false;
  return true;
}

export function ensureLeadBdcWorkflow(lead: Lead): Lead {
  if (!shouldEnableWorkflow(lead)) {
    lead.bdcAutomationEnabled = false;
    lead.bdcWorkflowVersion = WORKFLOW_VERSION;
    lead.bdcTouches = Array.isArray(lead.bdcTouches) ? lead.bdcTouches : [];
    lead.bdcNextTouchAt = undefined;
    return lead;
  }

  const createdAt = lead.createdAt || nowIso();
  const touches = pushUniqueTouches(Array.isArray(lead.bdcTouches) ? lead.bdcTouches : [], createdAt);
  lead.bdcAutomationEnabled = true;
  lead.bdcWorkflowVersion = WORKFLOW_VERSION;
  lead.bdcTouches = touches;
  lead.bdcNextTouchAt = nextPendingTouchAt(touches);
  return lead;
}

function renderSmsBody(lead: Lead, templateKey: string): string {
  const bookingUrl = bookingUrlForLead(lead);
  const greeting = leadGreeting(lead);
  const company = leadDisplayCompany(lead);
  const findings = lead.findings || "a few visibility gaps that may be costing local traffic";
  const city = lead.prospectCity || "your market";

  switch (templateKey) {
    case "day1-sms":
      return `${greeting} this is Jarvis with True Rank Digital. I reviewed ${company} and found ${findings}. If useful, book a free strategy call here: ${bookingUrl}`.trim();
    case "day2-sms":
      return `${greeting} quick follow-up from True Rank Digital. One fix like this recently lifted local visibility by 47% in 21 days. If you want, grab a free consult here: ${bookingUrl}`.trim();
    case "day7-sms":
      return `${greeting} quick AI search tip for ${company}: fresh GBP updates and stronger entity signals usually move the needle fastest. If you want the exact breakdown, book here: ${bookingUrl}`.trim();
    case "day14-sms":
      return `${greeting} still keeping an eye on ${company}. Competitors showing up in AI results for ${city} usually have cleaner authority signals behind the scenes. Free consult link: ${bookingUrl}`.trim();
    case "day35-sms":
      return `${greeting} one more visibility note from True Rank Digital. Businesses that tighten structured authority signals tend to win more local clicks without increasing ad spend. If you want to review it, here is the calendar: ${bookingUrl}`.trim();
    case "day60-sms":
      return `${greeting} sending a market pulse follow-up for ${company}. AI search is reshuffling who gets trust and traffic locally. If you want to see what changed in your market, book here: ${bookingUrl}`.trim();
    case "day90-sms":
      return `${greeting} last follow-up from True Rank Digital for now. If you still want a clean read on how ${company} can improve Google and AI visibility, here is the booking link: ${bookingUrl}`.trim();
    default:
      return `${greeting} this is True Rank Digital. If you want to review your Google and AI visibility opportunities, book here: ${bookingUrl}`.trim();
  }
}

function renderEmailTouch(lead: Lead, templateKey: string): { subject: string; body: string } {
  const company = leadDisplayCompany(lead);
  const findings = lead.findings || "a few visibility and authority gaps";
  const bookingUrl = bookingUrlForLead(lead);
  const greeting = lead.firstName ? `Hi ${lead.firstName},` : "Hi,";
  switch (templateKey) {
    case "day1-email":
      return {
        subject: `Quick visibility findings for ${company}`,
        body: `${greeting}\n\nI reviewed ${company} and found ${findings}.\n\nWhat stood out:\n- Authority signals appear weaker than they should be\n- AI search visibility is likely underperforming\n- There are practical fixes we can walk through quickly\n\nIf useful, here is the free strategy call link:\n${bookingUrl}\n\nJarvis\nTrue Rank Digital`
      };
    case "day3-email":
      return {
        subject: `${company} visibility follow-up`,
        body: `${greeting}\n\nFollowing up with a case-study angle: when local brands tighten Google authority and AI search signals together, they usually improve both trust and qualified traffic.\n\nIf you want us to walk through what that looks like for ${company}, here is the calendar:\n${bookingUrl}`
      };
    default:
      return {
        subject: `True Rank Digital follow-up for ${company}`,
        body: `${greeting}\n\nStill happy to walk you through the visibility opportunities we found for ${company}.\n\nBooking link:\n${bookingUrl}`
      };
  }
}

function logSummary(lead: Lead, templateKey: string, detail: string): string {
  return `[BDC ${templateKey}] ${detail}`;
}

async function reserveDueTouch(): Promise<{ lead: Lead; touch: BdcTouch } | undefined> {
  return withState((state) => {
    const now = Date.now();
    const leads = Object.values(state.leads)
      .filter((lead) => lead.bdcAutomationEnabled && Array.isArray(lead.bdcTouches) && lead.bdcTouches.length > 0)
      .sort((a, b) => Date.parse(a.bdcNextTouchAt || "") - Date.parse(b.bdcNextTouchAt || ""));

    for (const lead of leads) {
      if (lead.dnc || lead.status === "booked" || lead.status === "blocked") continue;
      const touches = lead.bdcTouches || [];
      const touch = touches.find((row) => row.status === "pending" && Number.isFinite(Date.parse(row.dueAt || "")) && Date.parse(row.dueAt || "") <= now);
      if (!touch) continue;
      touch.status = "processing";
      lead.bdcNextTouchAt = nextPendingTouchAt(touches.filter((row) => row.id !== touch.id ? true : false));
      lead.updatedAt = nowIso();
      return { lead: { ...lead, bdcTouches: touches.map((row) => ({ ...row })) }, touch: { ...touch } };
    }

    return undefined;
  });
}

async function finalizeTouch(leadId: string, touchId: string, patch: Partial<BdcTouch>, leadPatch: Partial<Lead> = {}): Promise<void> {
  await withState((state) => {
    const lead = state.leads[leadId];
    if (!lead || !Array.isArray(lead.bdcTouches)) return;
    const touch = lead.bdcTouches.find((row) => row.id === touchId);
    if (!touch) return;
    Object.assign(touch, patch);
    lead.bdcLastTouchAt = patch.executedAt || nowIso();
    lead.bdcNextTouchAt = nextPendingTouchAt(lead.bdcTouches);
    Object.assign(lead, leadPatch);
    lead.updatedAt = nowIso();
  });
}

function recentSmsExists(lead: Lead): boolean {
  const ts = Date.parse(lead.smsLastSentAt || "");
  return Number.isFinite(ts) && Date.now() - ts < RECENT_SMS_SUPPRESSION_MS;
}

function recentCallExists(lead: Lead): boolean {
  const ts = Date.parse(lead.lastAttemptAt || lead.callAttemptedAt || "");
  return Number.isFinite(ts) && Date.now() - ts < RECENT_CALL_SUPPRESSION_MS;
}

async function executeSmsTouch(lead: Lead, touch: BdcTouch): Promise<void> {
  if (!isTwilioSmsConfigured()) {
    await finalizeTouch(lead.id, touch.id, {
      status: "failed",
      executedAt: nowIso(),
      error: "Twilio SMS not configured",
      outcome: "sms-not-configured"
    });
    return;
  }
  if (recentSmsExists(lead)) {
    await finalizeTouch(lead.id, touch.id, {
      status: "skipped",
      executedAt: nowIso(),
      outcome: "recent-sms-suppressed"
    });
    return;
  }
  const body = renderSmsBody(lead, touch.templateKey);
  const sent = await sendSmsMessage({ to: lead.phone, body });
  await finalizeTouch(
    lead.id,
    touch.id,
    {
      status: "completed",
      executedAt: nowIso(),
      outcome: "sms-sent",
      preview: body
    },
    {
      smsLastSid: sent.sid,
      smsLastSentAt: nowIso(),
      smsLastType: `bdc-${touch.templateKey}`,
      smsLastError: undefined,
      notes: [lead.notes, logSummary(lead, touch.templateKey, "SMS sent")].filter(Boolean).join(" | ").slice(0, 1500)
    }
  );
}

async function executeEmailTouch(lead: Lead, touch: BdcTouch): Promise<void> {
  const draft = renderEmailTouch(lead, touch.templateKey);
  const note = [
    `BDC email touch due: ${touch.templateKey}`,
    `Subject: ${draft.subject}`,
    `Body:\n${draft.body}`,
    `Provider status: no outbound email provider is configured in this runtime; draft logged for follow-up.`
  ].join("\n");
  const ghl = await logLeadNoteToGhl({
    lead,
    note,
    tags: compactTags(["jarvis-bdc", `bdc:${touch.templateKey}`, "bdc-email-draft"]),
    upsertIfNeeded: true
  });
  await finalizeTouch(
    lead.id,
    touch.id,
    {
      status: ghl.synced ? "completed" : "failed",
      executedAt: nowIso(),
      outcome: ghl.synced ? "email-draft-logged" : "email-draft-log-failed",
      error: ghl.synced ? undefined : ghl.error,
      preview: draft.subject
    },
    {
      ghlContactId: ghl.contactId || lead.ghlContactId,
      ghlSyncedAt: ghl.synced ? nowIso() : lead.ghlSyncedAt,
      ghlLastError: ghl.synced ? undefined : ghl.error,
      notes: [lead.notes, logSummary(lead, touch.templateKey, `Email draft logged${ghl.synced ? " to GHL" : ""}`)].filter(Boolean).join(" | ").slice(0, 1500)
    }
  );
}

async function executeCallTouch(lead: Lead, touch: BdcTouch): Promise<void> {
  if (lead.status === "queued" || lead.status === "retry" || lead.status === "dialing") {
    await finalizeTouch(lead.id, touch.id, {
      status: "skipped",
      executedAt: nowIso(),
      outcome: "lead-already-active"
    });
    return;
  }
  if (recentCallExists(lead)) {
    await finalizeTouch(lead.id, touch.id, {
      status: "skipped",
      executedAt: nowIso(),
      outcome: "recent-call-suppressed"
    });
    return;
  }
  await finalizeTouch(
    lead.id,
    touch.id,
    {
      status: "completed",
      executedAt: nowIso(),
      outcome: "requeued-for-call"
    },
    {
      status: "queued",
      attempts: 0,
      nextAttemptAt: nowIso(),
      callId: undefined,
      callEndedAt: undefined,
      transcript: undefined,
      transcriptSummary: undefined,
      recordingUrl: undefined,
      outcome: undefined,
      notes: [lead.notes, logSummary(lead, touch.templateKey, "Lead re-queued for call follow-up")].filter(Boolean).join(" | ").slice(0, 1500)
    }
  );
}

async function executeTouch(lead: Lead, touch: BdcTouch): Promise<void> {
  const latest = await withState((state) => {
    const current = state.leads[lead.id];
    return current ? { ...current } : undefined;
  });
  if (!latest) return;
  if (!latest.bdcAutomationEnabled || latest.dnc || latest.status === "booked" || latest.status === "blocked") {
    await finalizeTouch(lead.id, touch.id, {
      status: "skipped",
      executedAt: nowIso(),
      outcome: "workflow-disabled-or-closed"
    });
    return;
  }

  try {
    if (touch.channel === "sms") {
      await executeSmsTouch(latest, touch);
    } else if (touch.channel === "email") {
      await executeEmailTouch(latest, touch);
    } else if (touch.channel === "call") {
      await executeCallTouch(latest, touch);
    }
    runtimeInfo("scheduler", "bdc touch executed", {
      leadId: lead.id,
      touchId: touch.id,
      channel: touch.channel,
      templateKey: touch.templateKey
    });
  } catch (error) {
    await finalizeTouch(lead.id, touch.id, {
      status: "failed",
      executedAt: nowIso(),
      outcome: "execution-failed",
      error: String(error).slice(0, 500)
    });
    runtimeError("scheduler", "bdc touch failed", error, {
      leadId: lead.id,
      touchId: touch.id,
      channel: touch.channel,
      templateKey: touch.templateKey
    });
  }
}

export async function processDueBdcActions(maxActions = MAX_RUN_ACTIONS): Promise<{ processed: number; found: number }> {
  let processed = 0;
  let found = 0;
  const limit = Math.max(1, Math.min(100, Math.trunc(maxActions || MAX_RUN_ACTIONS)));
  for (let i = 0; i < limit; i += 1) {
    const reserved = await reserveDueTouch();
    if (!reserved) break;
    found += 1;
    await executeTouch(reserved.lead, reserved.touch);
    processed += 1;
  }
  return { processed, found };
}

export async function getBdcAutomationStatus(): Promise<{
  enabledLeads: number;
  dueTouches: number;
  pendingTouches: number;
  completedTouches: number;
  failedTouches: number;
  sample: Array<{ leadId: string; company?: string; nextTouchAt?: string; pending: number }>;
}> {
  return withState((state) => {
    const leads = Object.values(state.leads);
    let enabledLeads = 0;
    let dueTouches = 0;
    let pendingTouches = 0;
    let completedTouches = 0;
    let failedTouches = 0;
    const sample: Array<{ leadId: string; company?: string; nextTouchAt?: string; pending: number }> = [];
    const now = Date.now();

    for (const lead of leads) {
      const touches = Array.isArray(lead.bdcTouches) ? lead.bdcTouches : [];
      if (!lead.bdcAutomationEnabled || touches.length === 0) continue;
      enabledLeads += 1;
      const pending = touches.filter((row) => row.status === "pending");
      pendingTouches += pending.length;
      completedTouches += touches.filter((row) => row.status === "completed").length;
      failedTouches += touches.filter((row) => row.status === "failed").length;
      dueTouches += pending.filter((row) => {
        const ts = Date.parse(row.dueAt || "");
        return Number.isFinite(ts) && ts <= now;
      }).length;
      if (sample.length < 20) {
        sample.push({
          leadId: lead.id,
          company: lead.company,
          nextTouchAt: lead.bdcNextTouchAt,
          pending: pending.length
        });
      }
    }

    sample.sort((a, b) => Date.parse(a.nextTouchAt || "") - Date.parse(b.nextTouchAt || ""));
    return { enabledLeads, dueTouches, pendingTouches, completedTouches, failedTouches, sample };
  });
}
