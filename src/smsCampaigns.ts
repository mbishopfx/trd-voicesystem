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
import { isTwilioSmsConfigured, sendSmsMessage } from "./integrations/twilioSms.js";
import { runtimeError, runtimeInfo } from "./runtimeLogs.js";
import { nowIso, sleep } from "./utils.js";

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
  updatedAt: string;
}

export interface RunSmsCsvCampaignOptions {
  csvContent: string;
  fileName?: string;
  campaignName?: string;
  template?: string;
  trustImportLeads?: boolean;
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

function normalizeVariableKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function buildVariableMap(row: CsvRow, campaignName: string, fallback: ReturnType<typeof buildLeadFromCsvRow>): Map<string, string> {
  const vars = new Map<string, string>();

  const put = (key: string, value: unknown): void => {
    const normalizedKey = normalizeVariableKey(key);
    const normalizedValue = toText(value);
    if (!normalizedKey) return;
    if (!normalizedValue) return;
    vars.set(normalizedKey, normalizedValue);
  };

  for (const [key, value] of Object.entries(row)) {
    put(key, value);
  }

  put("firstName", fallback?.firstName);
  put("lastName", fallback?.lastName);
  put("fullName", [fallback?.firstName, fallback?.lastName].filter(Boolean).join(" "));
  put("company", fallback?.company);
  put("business", fallback?.company);
  put("email", fallback?.email);
  put("phone", fallback?.phone);
  put("campaign", campaignName || fallback?.campaign);
  put("campaignName", campaignName || fallback?.campaign);
  put("timezone", fallback?.timezone);

  return vars;
}

function renderTemplate(template: string, vars: Map<string, string>): string {
  const base = String(template || "").trim();
  if (!base) return "";

  const rendered = base.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, token) => {
    const key = normalizeVariableKey(String(token || ""));
    return vars.get(key) || "";
  });

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

export function defaultSmsCampaignTemplate(): string {
  return config.smsCampaignDefaultTemplate;
}

export async function getSmsCampaignDashboard(): Promise<{
  runs: SmsCampaignRunLog[];
  defaultTemplate: string;
}> {
  const state = await loadSmsCampaignState();
  return {
    runs: [...state.runs].slice(-60).reverse(),
    defaultTemplate: defaultSmsCampaignTemplate()
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
