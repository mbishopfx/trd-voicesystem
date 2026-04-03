import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import {
  disableDatabaseState,
  hasDatabaseState,
  loadDbJsonState,
  saveDbJsonState,
  withDbJsonState
} from "./stateDb.js";
import { buildLeadFromCsvRow, parseCsvRows, type CsvRow } from "./ingest.js";
import { isTwilioSmsConfigured, listTwilioMessages, sendSmsMessage } from "./integrations/twilioSms.js";
import { extractLeadVariables, normalizeVariableKey } from "./leadVariables.js";
import { normalizePhone } from "./phone.js";
import { runtimeError, runtimeInfo } from "./runtimeLogs.js";
import { withState } from "./store.js";
import { nowIso, sleep } from "./utils.js";
import type { Lead } from "./types.js";

export interface SmsCampaignDelivery {
  row: number;
  phone: string;
  status: "sent" | "failed" | "skipped";
  sid?: string;
  error?: string;
  bodyPreview?: string;
}

export interface SmsCampaignRunLog {
  id: string;
  trigger: "manual";
  status: "running" | "completed" | "error" | "skipped";
  startedAt: string;
  completedAt?: string;
  fileName: string;
  campaignName: string;
  templatePreview: string;
  totalRows: number;
  validRows: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  invalidCount: number;
  blockedCount: number;
  duplicateCount: number;
  summary: string;
  errors: string[];
  deliveries: SmsCampaignDelivery[];
}

interface SmsCampaignState {
  runs: SmsCampaignRunLog[];
  replyMarkers: Record<
    string,
    {
      lastInboundSid?: string;
      lastFollowUpSentAt?: string;
      lastFollowUpSid?: string;
      optedOutAt?: string;
      optOutReason?: string;
    }
  >;
  deletedThreads: Record<string, { deletedAt: string }>;
  updatedAt: string;
}

export interface RunSmsCsvCampaignOptions {
  csvContent: string;
  fileName?: string;
  campaignName?: string;
  template?: string;
  trustImportLeads?: boolean;
}

export interface SmsReplyFollowUpScanResult {
  id: string;
  status: "completed" | "error" | "skipped";
  startedAt: string;
  completedAt?: string;
  scannedThreads: number;
  sentCount: number;
  skippedCount: number;
  optOutCount: number;
  summary: string;
  errors: string[];
}

const STATE_KEY = "sms_campaign_registry";
const MAX_RUN_LOGS = 120;
const MAX_DELIVERY_ROWS = 120;

let dbFallbackWarned = false;
let memoryFallbackWarned = false;
let memoryState: SmsCampaignState | undefined;

function createEmptyState(): SmsCampaignState {
  return {
    runs: [],
    replyMarkers: {},
    deletedThreads: {},
    updatedAt: nowIso()
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getMemoryState(): SmsCampaignState {
  if (!memoryState) memoryState = createEmptyState();
  return clone(memoryState);
}

function normalizeState(state: SmsCampaignState): SmsCampaignState {
  state.runs = Array.isArray(state.runs) ? state.runs.slice(-MAX_RUN_LOGS) : [];
  state.replyMarkers = state.replyMarkers && typeof state.replyMarkers === "object" ? state.replyMarkers : {};
  state.deletedThreads = state.deletedThreads && typeof state.deletedThreads === "object" ? state.deletedThreads : {};
  state.updatedAt = state.updatedAt || nowIso();
  return state;
}

async function ensureStateFile(): Promise<void> {
  await fs.mkdir(path.dirname(config.smsCampaignStatePath), { recursive: true });
  try {
    await fs.access(config.smsCampaignStatePath);
  } catch {
    await fs.writeFile(config.smsCampaignStatePath, JSON.stringify(createEmptyState(), null, 2), "utf8");
  }
}

async function acquireLock(timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    try {
      const handle = await fs.open(config.smsCampaignLockPath, "wx");
      await handle.close();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Could not acquire SMS campaign lock after ${timeoutMs}ms`);
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(config.smsCampaignLockPath);
  } catch {
    // no-op
  }
}

async function loadSmsCampaignState(): Promise<SmsCampaignState> {
  if (hasDatabaseState()) {
    try {
      const parsed = await loadDbJsonState<SmsCampaignState>(STATE_KEY, createEmptyState());
      return normalizeState(parsed);
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[SMS-CAMPAIGN] Database unavailable; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  try {
    await ensureStateFile();
    const raw = await fs.readFile(config.smsCampaignStatePath, "utf8");
    const parsed = normalizeState(JSON.parse(raw) as SmsCampaignState);
    memoryState = clone(parsed);
    return parsed;
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[SMS-CAMPAIGN] Filesystem unavailable; using in-memory state.", error);
      memoryFallbackWarned = true;
    }
    return getMemoryState();
  }
}

async function saveSmsCampaignState(state: SmsCampaignState): Promise<void> {
  state.updatedAt = nowIso();

  if (hasDatabaseState()) {
    try {
      await saveDbJsonState(STATE_KEY, state);
      return;
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[SMS-CAMPAIGN] Database save failed; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  try {
    await ensureStateFile();
    const tempPath = `${config.smsCampaignStatePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tempPath, config.smsCampaignStatePath);
    memoryState = clone(state);
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[SMS-CAMPAIGN] Filesystem save failed; using in-memory state only.", error);
      memoryFallbackWarned = true;
    }
    memoryState = clone(state);
  }
}

async function withSmsCampaignState<T>(fn: (state: SmsCampaignState) => Promise<T> | T): Promise<T> {
  if (hasDatabaseState()) {
    try {
      return withDbJsonState(STATE_KEY, createEmptyState, async (state) => {
        normalizeState(state as SmsCampaignState);
        return fn(state as SmsCampaignState);
      });
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[SMS-CAMPAIGN] Database transaction failed; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  let lockAcquired = false;
  try {
    await acquireLock();
    lockAcquired = true;
    const state = await loadSmsCampaignState();
    const result = await fn(state);
    await saveSmsCampaignState(state);
    return result;
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[SMS-CAMPAIGN] Lock/filesystem unavailable; using in-memory state.", error);
      memoryFallbackWarned = true;
    }
    const state = getMemoryState();
    const result = await fn(state);
    state.updatedAt = nowIso();
    memoryState = clone(state);
    return result;
  } finally {
    if (lockAcquired) {
      await releaseLock();
    }
  }
}

function appendRun(state: SmsCampaignState, run: SmsCampaignRunLog): void {
  state.runs.push(run);
  if (state.runs.length > MAX_RUN_LOGS) {
    state.runs = state.runs.slice(state.runs.length - MAX_RUN_LOGS);
  }
  state.updatedAt = nowIso();
}

function toText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function buildVariableMap(row: CsvRow, campaignName: string, fallback: ReturnType<typeof buildLeadFromCsvRow>): Map<string, string> {
  return new Map(
    Object.entries(
      extractLeadVariables(row, fallback || undefined, {
        campaign: campaignName || fallback?.campaign || "",
        campaignName: campaignName || fallback?.campaign || ""
      })
    )
  );
}

function renderTemplate(template: string, vars: Map<string, string>): string {
  const base = String(template || "").trim();
  if (!base) return "";

  const resolveToken = (token: string): string => {
    const key = normalizeVariableKey(String(token || ""));
    return vars.get(key) || "";
  };
  const withBraces = base.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, token) => resolveToken(String(token || "")));
  const rendered = withBraces.replace(/\[\s*([a-zA-Z0-9_]+?)\s*\]/g, (_match, token) => resolveToken(String(token || "")));

  return rendered
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeFileName(input?: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "uploaded.csv";
  return raw.slice(0, 160);
}

function trimErrors(errors: string[]): string[] {
  return errors.map((entry) => entry.slice(0, 220)).slice(-80);
}

function normalizeSmsPhone(value: string): string {
  return normalizePhone(value) || String(value || "").trim();
}

function detectOptOutIntent(message: string): string | undefined {
  const normalized = String(message || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;

  const words = normalized.split(" ").filter(Boolean);

  const directMatches = new Set([
    "stop",
    "stopall",
    "unsubscribe",
    "cancel",
    "end",
    "quit",
    "remove",
    "opt out",
    "do not text",
    "dont text",
    "do not contact",
    "dont contact"
  ]);
  if (directMatches.has(normalized)) return normalized;

  if (words.length <= 4 && /\b(stop|unsubscribe|remove|cancel|quit|end)\b/.test(normalized)) {
    return normalized;
  }
  if (/\b(do not|dont)\s+(text|contact|message)\b/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

export async function getSmsOptOutStatus(phone: string): Promise<{ optedOut: boolean; reason?: string; at?: string }> {
  const normalizedPhone = normalizeSmsPhone(phone);
  if (!normalizedPhone) return { optedOut: false };
  const state = await loadSmsCampaignState();
  const marker = state.replyMarkers?.[normalizedPhone];
  return {
    optedOut: Boolean(marker?.optedOutAt),
    reason: marker?.optOutReason,
    at: marker?.optedOutAt
  };
}

export async function isSmsThreadDeleted(phone: string): Promise<boolean> {
  const normalizedPhone = normalizeSmsPhone(phone);
  if (!normalizedPhone) return false;
  const state = await loadSmsCampaignState();
  return Boolean(state.deletedThreads?.[normalizedPhone]?.deletedAt);
}

export async function getDeletedSmsThreadPhones(): Promise<Set<string>> {
  const state = await loadSmsCampaignState();
  return new Set(
    Object.keys(state.deletedThreads || {})
      .map((phone) => normalizeSmsPhone(phone))
      .filter(Boolean)
  );
}

export async function deleteSmsThread(phone: string): Promise<{ phone: string; deletedAt: string }> {
  const normalizedPhone = normalizeSmsPhone(phone);
  if (!normalizedPhone) {
    throw new Error("Valid phone is required");
  }
  const deletedAt = nowIso();
  await withSmsCampaignState((state) => {
    state.deletedThreads = state.deletedThreads && typeof state.deletedThreads === "object" ? state.deletedThreads : {};
    state.deletedThreads[normalizedPhone] = { deletedAt };
  });
  return { phone: normalizedPhone, deletedAt };
}

async function markPhoneOptedOut(phone: string, reason: string): Promise<void> {
  const normalizedPhone = normalizeSmsPhone(phone);
  const optedOutAt = nowIso();
  await withSmsCampaignState((state) => {
    state.replyMarkers = state.replyMarkers && typeof state.replyMarkers === "object" ? state.replyMarkers : {};
    state.replyMarkers[normalizedPhone] = {
      ...(state.replyMarkers[normalizedPhone] || {}),
      optedOutAt,
      optOutReason: reason
    };
  });

  await withState((state) => {
    for (const lead of Object.values(state.leads)) {
      if (normalizeSmsPhone(lead.phone) !== normalizedPhone) continue;
      lead.dnc = true;
      lead.status = "blocked";
      lead.bdcAutomationEnabled = false;
      lead.nextAttemptAt = undefined;
      lead.lastError = `SMS opt-out: ${reason}`;
      lead.updatedAt = optedOutAt;
    }
  });
}

export function defaultSmsCampaignTemplate(): string {
  return config.smsCampaignDefaultTemplate;
}

export function defaultSmsCampaignReplyTemplate(): string {
  return config.smsCampaignReplyTemplate;
}

export async function getSmsCampaignDashboard(): Promise<{
  runs: SmsCampaignRunLog[];
  defaultTemplate: string;
  defaultReplyTemplate: string;
  defaultMyName: string;
}> {
  const state = await loadSmsCampaignState();
  return {
    runs: [...state.runs].slice(-60).reverse(),
    defaultTemplate: defaultSmsCampaignTemplate(),
    defaultReplyTemplate: defaultSmsCampaignReplyTemplate(),
    defaultMyName: config.smsCampaignDefaultMyName
  };
}

export async function runSmsCsvCampaign(options: RunSmsCsvCampaignOptions): Promise<SmsCampaignRunLog> {
  if (!isTwilioSmsConfigured()) {
    throw new Error("Twilio SMS is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)");
  }

  const csvContent = String(options.csvContent || "");
  if (!csvContent.trim()) {
    throw new Error("csvContent is required");
  }

  const template = String(options.template || defaultSmsCampaignTemplate()).trim();
  if (!template) {
    throw new Error("SMS template is required");
  }

  const rows = parseCsvRows(csvContent);
  const runId = `sms-csv-${Date.now()}`;
  const startedAt = nowIso();
  const fileName = safeFileName(options.fileName);
  const campaignName = (String(options.campaignName || "").trim() || `SMS Campaign ${new Date().toLocaleDateString()}`).slice(0, 120);
  const cpsDelayMs = Math.max(0, Math.ceil(1000 / Math.max(0.1, config.twilioCps)));
  const existingState = await loadSmsCampaignState();
  const optedOutPhones = new Set(
    Object.entries(existingState.replyMarkers || {})
      .filter(([, marker]) => Boolean(marker?.optedOutAt))
      .map(([phone]) => normalizeSmsPhone(phone))
      .filter(Boolean)
  );

  const run: SmsCampaignRunLog = {
    id: runId,
    trigger: "manual",
    status: "running",
    startedAt,
    fileName,
    campaignName,
    templatePreview: template.slice(0, 240),
    totalRows: rows.length,
    validRows: 0,
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    invalidCount: 0,
    blockedCount: 0,
    duplicateCount: 0,
    summary: "SMS campaign started.",
    errors: [],
    deliveries: []
  };

  await withSmsCampaignState((state) => {
    appendRun(state, run);
  });

  try {
    if (!rows.length) {
      run.status = "skipped";
      run.completedAt = nowIso();
      run.summary = "CSV has no data rows.";
      return run;
    }

    const sentPhones = new Set<string>();
    let throttledSends = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const sourceRow = i + 2;
      const lead = buildLeadFromCsvRow(rows[i], fileName, sourceRow, {
        trustImportLeads: options.trustImportLeads ?? true
      });

      if (!lead) {
        run.invalidCount += 1;
        run.skippedCount += 1;
        continue;
      }

      run.validRows += 1;

      if (lead.dnc) {
        run.blockedCount += 1;
        run.skippedCount += 1;
        run.deliveries.push({
          row: sourceRow,
          phone: lead.phone,
          status: "skipped",
          error: "DNC/opt-out"
        });
        continue;
      }

      if (optedOutPhones.has(normalizeSmsPhone(lead.phone))) {
        run.blockedCount += 1;
        run.skippedCount += 1;
        run.deliveries.push({
          row: sourceRow,
          phone: lead.phone,
          status: "skipped",
          error: "SMS opt-out"
        });
        continue;
      }

      if (sentPhones.has(lead.phone)) {
        run.duplicateCount += 1;
        run.skippedCount += 1;
        run.deliveries.push({
          row: sourceRow,
          phone: lead.phone,
          status: "skipped",
          error: "Duplicate phone in CSV"
        });
        continue;
      }

      sentPhones.add(lead.phone);
      const vars = buildVariableMap(rows[i], campaignName, lead);
      const message = renderTemplate(template, vars);
      if (!message) {
        run.failedCount += 1;
        const err = `Row ${sourceRow}: message empty after variable rendering`;
        run.errors.push(err);
        run.deliveries.push({
          row: sourceRow,
          phone: lead.phone,
          status: "failed",
          error: "Message empty after rendering"
        });
        continue;
      }

      try {
        const sent = await sendSmsMessage({ to: lead.phone, body: message });
        run.sentCount += 1;
        run.deliveries.push({
          row: sourceRow,
          phone: lead.phone,
          status: "sent",
          sid: sent.sid,
          bodyPreview: message.slice(0, 160)
        });
      } catch (error) {
        run.failedCount += 1;
        const errText = String(error).slice(0, 220);
        run.errors.push(`Row ${sourceRow}: ${errText}`);
        run.deliveries.push({
          row: sourceRow,
          phone: lead.phone,
          status: "failed",
          error: errText,
          bodyPreview: message.slice(0, 160)
        });
      }

      throttledSends += 1;
      if (cpsDelayMs > 0 && throttledSends < rows.length) {
        await sleep(cpsDelayMs);
      }
    }

    run.deliveries = run.deliveries.slice(-MAX_DELIVERY_ROWS);
    run.errors = trimErrors(run.errors);
    run.status = run.sentCount > 0 ? "completed" : run.failedCount > 0 ? "error" : "skipped";
    run.completedAt = nowIso();
    run.summary = `Rows ${run.totalRows}, sent ${run.sentCount}, failed ${run.failedCount}, skipped ${run.skippedCount}, invalid ${run.invalidCount}, blocked ${run.blockedCount}, duplicates ${run.duplicateCount}.`;

    runtimeInfo("twilio", "sms csv campaign completed", {
      runId: run.id,
      fileName,
      campaignName,
      rows: run.totalRows,
      sentCount: run.sentCount,
      failedCount: run.failedCount,
      skippedCount: run.skippedCount
    });
  } catch (error) {
    run.status = "error";
    run.completedAt = nowIso();
    run.summary = "SMS CSV campaign failed.";
    run.errors = trimErrors([...run.errors, String(error)]);
    runtimeError("twilio", "sms csv campaign failed", error, {
      runId: run.id,
      fileName,
      campaignName
    });
  } finally {
    await withSmsCampaignState((state) => {
      const target = state.runs.find((item) => item.id === run.id);
      if (target) {
        Object.assign(target, run);
      } else {
        appendRun(state, run);
      }
    });
  }

  return run;
}

function leadByPhoneMap(leads: Lead[]): Map<string, Lead> {
  const out = new Map<string, Lead>();
  for (const lead of leads) {
    const normalized = normalizePhone(lead.phone || "");
    if (!normalized) continue;
    if (!out.has(normalized)) out.set(normalized, lead);
  }
  return out;
}

export async function runSmsReplyFollowUpScan(input?: {
  template?: string;
  myName?: string;
  pageSize?: number;
}): Promise<SmsReplyFollowUpScanResult> {
  if (!isTwilioSmsConfigured()) {
    throw new Error("Twilio SMS is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)");
  }

  const template = String(input?.template || defaultSmsCampaignReplyTemplate()).trim();
  if (!template) {
    throw new Error("Reply follow-up template is required");
  }

  const myName = String(input?.myName || config.smsCampaignDefaultMyName || "Jarvis").trim() || "Jarvis";
  const pageSize = Math.max(20, Math.min(100, Math.trunc(Number(input?.pageSize || 100))));
  const run: SmsReplyFollowUpScanResult = {
    id: `sms-reply-scan-${Date.now()}`,
    status: "completed",
    startedAt: nowIso(),
    scannedThreads: 0,
    sentCount: 0,
    skippedCount: 0,
    optOutCount: 0,
    summary: "Reply scan completed.",
    errors: []
  };

  try {
    const [campaignState, leads, messages] = await Promise.all([
      loadSmsCampaignState(),
      withState((state) => Object.values(state.leads).map((lead) => ({ ...lead }))),
      listTwilioMessages({ pageSize })
    ]);
    const markerByPhone = campaignState.replyMarkers || {};
    const leadMap = leadByPhoneMap(leads);
    const twilioNumber = normalizePhone(config.twilioPhoneNumber || "") || "";

    const normalized = messages
      .map((row) => {
        const from = String(row.from || "").trim();
        const to = String(row.to || "").trim();
        const fromNormalized = normalizePhone(from) || from;
        const toNormalized = normalizePhone(to) || to;
        const direction = String(row.direction || "").toLowerCase();
        const inbound =
          direction.includes("inbound") || (Boolean(twilioNumber) && toNormalized === twilioNumber && fromNormalized !== twilioNumber);
        const counterparty = inbound ? fromNormalized : toNormalized;
        const stamp = row.dateSent || row.dateCreated || row.dateUpdated || "";
        const ts = Date.parse(stamp);
        return {
          sid: String(row.sid || "").trim(),
          inbound,
          counterparty,
          body: String(row.body || "").trim(),
          timestampMs: Number.isFinite(ts) ? ts : 0,
          dateStamp: stamp
        };
      })
      .filter((row) => Boolean(row.counterparty));

    const threads = new Map<string, typeof normalized>();
    for (const row of normalized) {
      const key = row.counterparty;
      const bucket = threads.get(key) || [];
      bucket.push(row);
      threads.set(key, bucket);
    }

    run.scannedThreads = threads.size;
    const markerUpdates: Record<
      string,
      {
        lastInboundSid?: string;
        lastFollowUpSentAt?: string;
        lastFollowUpSid?: string;
        optedOutAt?: string;
        optOutReason?: string;
      }
    > = {};

    for (const [phone, rows] of threads.entries()) {
      const sortedDesc = rows.slice().sort((a, b) => b.timestampMs - a.timestampMs);
      const latestInbound = sortedDesc.find((row) => row.inbound);
      if (!latestInbound) {
        run.skippedCount += 1;
        continue;
      }

      const lastMarker = markerByPhone[phone];
      const optOutReason = detectOptOutIntent(latestInbound.body);
      if (optOutReason) {
        markerUpdates[phone] = {
          ...(markerUpdates[phone] || lastMarker || {}),
          lastInboundSid: latestInbound.sid || lastMarker?.lastInboundSid,
          optedOutAt: nowIso(),
          optOutReason
        };
        await markPhoneOptedOut(phone, optOutReason);
        run.optOutCount += 1;
        run.skippedCount += 1;
        continue;
      }

      if (lastMarker?.optedOutAt) {
        markerUpdates[phone] = {
          ...(markerUpdates[phone] || lastMarker || {}),
          lastInboundSid: latestInbound.sid || lastMarker?.lastInboundSid
        };
        run.skippedCount += 1;
        continue;
      }

      if (latestInbound.sid && lastMarker?.lastInboundSid === latestInbound.sid) {
        run.skippedCount += 1;
        continue;
      }

      const alreadyReplied = sortedDesc.some((row) => !row.inbound && row.timestampMs > latestInbound.timestampMs);
      if (alreadyReplied) {
        markerUpdates[phone] = {
          ...(markerUpdates[phone] || lastMarker || {}),
          lastInboundSid: latestInbound.sid || lastMarker?.lastInboundSid
        };
        run.skippedCount += 1;
        continue;
      }

      const lead = leadMap.get(phone);
      const vars = new Map<string, string>();
      const setVar = (key: string, value: string): void => {
        const normalizedKey = normalizeVariableKey(key);
        if (!normalizedKey) return;
        vars.set(normalizedKey, String(value || "").trim());
      };
      setVar("my_name", myName);
      setVar("first_name", lead?.firstName || "there");
      setVar("company_name", lead?.company || "your business");
      setVar("city", lead?.prospectCity || "your area");
      setVar("inbound_message", latestInbound.body || "");
      setVar("phone", phone);

      const rendered = renderTemplate(template, vars);
      if (!rendered) {
        run.errors.push(`Skipped ${phone}: reply follow-up rendered empty`);
        run.skippedCount += 1;
        continue;
      }

      try {
        const sent = await sendSmsMessage({ to: phone, body: rendered });
        markerUpdates[phone] = {
          ...(markerUpdates[phone] || lastMarker || {}),
          lastInboundSid: latestInbound.sid || lastMarker?.lastInboundSid,
          lastFollowUpSentAt: nowIso(),
          lastFollowUpSid: sent.sid
        };
        run.sentCount += 1;
      } catch (error) {
        run.errors.push(`Failed ${phone}: ${String(error).slice(0, 180)}`);
      }
    }

    await withSmsCampaignState((state) => {
      state.replyMarkers = state.replyMarkers && typeof state.replyMarkers === "object" ? state.replyMarkers : {};
      for (const [phone, marker] of Object.entries(markerUpdates)) {
        state.replyMarkers[phone] = {
          ...(state.replyMarkers[phone] || {}),
          ...marker
        };
      }
    });

    run.completedAt = nowIso();
    run.status = run.sentCount > 0 ? "completed" : "skipped";
    run.summary = `Scanned ${run.scannedThreads} threads, sent ${run.sentCount}, opted out ${run.optOutCount}, skipped ${run.skippedCount}.`;
    run.errors = trimErrors(run.errors);
    runtimeInfo("twilio", "sms reply follow-up scan completed", {
      runId: run.id,
      scannedThreads: run.scannedThreads,
      sentCount: run.sentCount,
      skippedCount: run.skippedCount
    });
  } catch (error) {
    run.status = "error";
    run.completedAt = nowIso();
    run.summary = "Reply scan failed.";
    run.errors = trimErrors([...run.errors, String(error)]);
    runtimeError("twilio", "sms reply follow-up scan failed", error, {
      runId: run.id
    });
  }

  return run;
}
