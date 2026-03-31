import { config } from "./config.js";
import { isWithinCallingWindow } from "./time.js";
import { withState } from "./store.js";
import type { Lead, LeadStatus } from "./types.js";
import { nowIso, randomInt } from "./utils.js";
import { createOutboundCall, HttpError } from "./vapiClient.js";
import { syncLeadToGhl } from "./integrations/ghl.js";
import { runtimeError, runtimeInfo } from "./runtimeLogs.js";
import { getVapiCreditGuardStatus } from "./vapiCredits.js";

const ACTIVE_QUEUE: LeadStatus[] = ["queued", "retry"];
let dialerCooldownUntil = 0;
let lastCreditGuardLogKey = "";

export function setDialerPostCallCooldown(delayMs: number): void {
  const ms = Math.max(0, Math.trunc(delayMs));
  if (ms <= 0) return;
  const next = Date.now() + ms;
  if (next > dialerCooldownUntil) {
    dialerCooldownUntil = next;
  }
}

export function getDialerCooldownRemainingMs(): number {
  return Math.max(0, dialerCooldownUntil - Date.now());
}

export async function resetStuckDialingLeads(stuckSeconds = 180): Promise<{
  checked: number;
  reset: number;
  failed: number;
  thresholdSeconds: number;
}> {
  const thresholdSeconds = Math.max(30, Math.trunc(stuckSeconds));
  const cutoffTs = Date.now() - thresholdSeconds * 1000;

  return withState((state) => {
    let checked = 0;
    let reset = 0;
    let failed = 0;
    const now = nowIso();

    for (const lead of Object.values(state.leads)) {
      if (lead.status !== "dialing") continue;
      checked += 1;

      const timestamps = [lead.callAttemptedAt, lead.lastAttemptAt, lead.updatedAt]
        .map((value) => (value ? Date.parse(value) : Number.NaN))
        .filter((value) => Number.isFinite(value)) as number[];

      const latestTs = timestamps.length > 0 ? Math.max(...timestamps) : 0;
      if (latestTs > cutoffTs) continue;

      if (lead.attempts >= config.maxAttempts) {
        lead.status = "failed";
        lead.nextAttemptAt = undefined;
        lead.lastError = `Auto-failed by stale dialing reset (${thresholdSeconds}s threshold).`;
        failed += 1;
      } else {
        lead.status = "retry";
        lead.nextAttemptAt = now;
        lead.lastError = `Recovered from stale dialing state (${thresholdSeconds}s threshold).`;
        reset += 1;
      }

      lead.updatedAt = now;
    }

    return { checked, reset, failed, thresholdSeconds };
  });
}

function shouldRetry(statusCode: number): boolean {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(statusCode);
}

function isOverConcurrencyLimitError(body?: string): boolean {
  const raw = String(body || "").trim();
  if (!raw) return false;
  const lowered = raw.toLowerCase();
  if (lowered.includes("over concurrency limit")) return true;
  if (lowered.includes("concurrencyblocked")) return true;
  if (lowered.includes("remainingconcurrentcalls")) return true;

  try {
    const parsed = JSON.parse(raw) as {
      message?: string;
      subscriptionLimits?: { concurrencyBlocked?: boolean; remainingConcurrentCalls?: number };
    };
    if (String(parsed.message || "").toLowerCase().includes("over concurrency limit")) return true;
    if (parsed.subscriptionLimits?.concurrencyBlocked) return true;
    if (typeof parsed.subscriptionLimits?.remainingConcurrentCalls === "number") {
      return parsed.subscriptionLimits.remainingConcurrentCalls < 1;
    }
  } catch {
    // body is not JSON
  }

  return false;
}

function shouldRetryHttpError(error: HttpError): boolean {
  if (shouldRetry(error.status)) return true;
  if (error.status === 400 && isOverConcurrencyLimitError(error.body)) return true;
  return false;
}

function computeBackoffMs(attempt: number): number {
  const exponential = config.retryBaseSeconds * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, config.retryMaxSeconds);
  return capped * 1000 + randomInt(0, 750);
}

function isEligible(lead: Lead, now: Date): boolean {
  if (!ACTIVE_QUEUE.includes(lead.status)) return false;
  if (lead.attempts >= config.maxAttempts) return false;
  if (lead.dnc) return false;
  if (lead.sourceFile === 'prospector-dashboard' && !lead.prospectAutoDialApproved) return false;

  if (lead.nextAttemptAt) {
    const dueAt = Date.parse(lead.nextAttemptAt);
    if (Number.isFinite(dueAt) && dueAt > now.getTime()) return false;
  }

  return isWithinCallingWindow(
    now,
    lead.timezone || config.defaultTimezone,
    config.callWindowStartHour,
    config.callWindowEndHour
  );
}

async function reserveLead(): Promise<Lead | undefined> {
  const creditStatus = await getVapiCreditGuardStatus();
  const creditLogKey = `${creditStatus.stopDialing}|${creditStatus.fetchOk}|${creditStatus.availableCredits ?? "na"}|${creditStatus.reason}`;
  if (creditLogKey !== lastCreditGuardLogKey) {
    lastCreditGuardLogKey = creditLogKey;
    if (creditStatus.stopDialing) {
      runtimeInfo("dialer", "dialer paused due low Vapi credits", {
        availableCredits: creditStatus.availableCredits,
        minCredits: creditStatus.minCredits,
        checkedAt: creditStatus.checkedAt,
        sourceEndpoint: creditStatus.sourceEndpoint || ""
      });
    } else if (!creditStatus.fetchOk) {
      runtimeInfo("dialer", "Vapi credit check unavailable; continuing dialer", {
        reason: creditStatus.reason,
        checkedAt: creditStatus.checkedAt
      });
    } else {
      runtimeInfo("dialer", "Vapi credit guard check passed", {
        availableCredits: creditStatus.availableCredits,
        minCredits: creditStatus.minCredits,
        checkedAt: creditStatus.checkedAt,
        sourceEndpoint: creditStatus.sourceEndpoint || ""
      });
    }
  }

  if (creditStatus.stopDialing) {
    return undefined;
  }

  if (Date.now() < dialerCooldownUntil) {
    return undefined;
  }

  const now = new Date();

  return withState((state) => {
    const candidates = Object.values(state.leads)
      .filter((lead) => isEligible(lead, now))
      .sort((a, b) => {
        const aDue = a.nextAttemptAt ? Date.parse(a.nextAttemptAt) : 0;
        const bDue = b.nextAttemptAt ? Date.parse(b.nextAttemptAt) : 0;
        return aDue - bDue;
      });

    const lead = candidates[0];
    if (!lead) return undefined;

    lead.status = "dialing";
    lead.attempts += 1;
    lead.lastAttemptAt = nowIso();
    lead.updatedAt = nowIso();
    return { ...lead };
  });
}

async function markCallCreated(leadId: string, callId: string): Promise<Lead | undefined> {
  return withState((state) => {
    const lead = state.leads[leadId];
    if (!lead) return undefined;

    lead.callId = callId;
    lead.status = "dialing";
    lead.outcome = "call_started";
    lead.callAttemptedAt = nowIso();
    lead.updatedAt = nowIso();
    lead.lastError = undefined;
    lead.nextAttemptAt = undefined;

    return { ...lead };
  });
}

async function applyGhlSyncResult(
  leadId: string,
  result: { synced: boolean; contactId?: string; error?: string }
): Promise<void> {
  await withState((state) => {
    const lead = state.leads[leadId];
    if (!lead) return;
    lead.ghlContactId = result.contactId || lead.ghlContactId;
    lead.ghlSyncedAt = result.synced ? nowIso() : lead.ghlSyncedAt;
    lead.ghlLastError = result.synced ? undefined : result.error || lead.ghlLastError;
    lead.updatedAt = nowIso();
  });
}

async function markFailure(leadId: string, message: string, retryable: boolean): Promise<void> {
  await withState((state) => {
    const lead = state.leads[leadId];
    if (!lead) return;

    lead.lastError = message;
    lead.updatedAt = nowIso();

    if (retryable && lead.attempts < config.maxAttempts) {
      const retryAfterMs = computeBackoffMs(lead.attempts);
      lead.status = "retry";
      lead.nextAttemptAt = new Date(Date.now() + retryAfterMs).toISOString();
      return;
    }

    lead.status = "failed";
    lead.nextAttemptAt = undefined;
  });
}

export async function dialOneLead(): Promise<{ dispatched: boolean; message: string }> {
  const lead = await reserveLead();
  if (!lead) {
    return { dispatched: false, message: "No eligible leads" };
  }

  runtimeInfo("worker", "Lead reserved for dialing", {
    leadId: lead.id,
    phone: lead.phone,
    attempts: lead.attempts,
    status: lead.status
  });

  try {
    runtimeInfo("worker", "Creating outbound Vapi call", {
      leadId: lead.id,
      phone: lead.phone,
      assistantIdOverride: lead.assistantIdOverride || "",
      bookingUrlOverride: lead.bookingUrlOverride || ""
    });
    const additionalVariables: Record<string, string> = {};
    if (lead.bookingUrlOverride) {
      additionalVariables.bookingUrl = lead.bookingUrlOverride;
      additionalVariables.calendlyUrl = lead.bookingUrlOverride;
      additionalVariables.googleCalendarUrl = lead.bookingUrlOverride;
    }

    const result = await createOutboundCall(lead, {
      assistantId: lead.assistantIdOverride || lead.prospectorCallAssistantId || undefined,
      additionalVariables: Object.keys(additionalVariables).length ? additionalVariables : undefined
    });
    const attemptedLead = await markCallCreated(lead.id, result.id);
    runtimeInfo("worker", "Call created", {
      leadId: lead.id,
      callId: result.id
    });
    if (attemptedLead && config.ghlSyncOnCallAttempt) {
      const sync = await syncLeadToGhl({
        lead: attemptedLead,
        outcome: attemptedLead.outcome,
        transcript: attemptedLead.transcript
      });
      await applyGhlSyncResult(attemptedLead.id, sync);
      runtimeInfo("worker", "GHL synced on call attempt", {
        leadId: attemptedLead.id,
        synced: sync.synced,
        contactId: sync.contactId || ""
      });
    }
    return { dispatched: true, message: `Created Vapi call ${result.id} for ${lead.phone}` };
  } catch (error) {
    if (error instanceof HttpError) {
      const retryable = shouldRetryHttpError(error);
      await markFailure(lead.id, `${error.message}: ${error.body}`.slice(0, 600), retryable);
      runtimeError("worker", `HTTP call create failed (retryable=${retryable})`, error, {
        leadId: lead.id,
        status: error.status
      });
      return {
        dispatched: true,
        message: `Lead ${lead.id} failed with HTTP ${error.status}; retryable=${retryable}`
      };
    }

    await markFailure(lead.id, String(error), true);
    runtimeError("worker", "Unknown call create failure", error, {
      leadId: lead.id
    });
    return { dispatched: true, message: `Lead ${lead.id} failed with unknown error` };
  }
}
