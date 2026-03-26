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
import { fetchLocationContacts, logBulkSchedulerQueuedContact, type GhlSmartListContact } from "./integrations/ghl.js";
import { normalizePhone } from "./phone.js";
import { runtimeError, runtimeInfo } from "./runtimeLogs.js";
import { withState } from "./store.js";
import type { Lead } from "./types.js";
import { hashShort, nowIso } from "./utils.js";

export interface BulkSchedulerSettings {
  enabled: boolean;
  timezone: string;
  scheduleHours: number[];
  runWindowMinutes: number;
  batchSize: number;
  samplePoolSize: number;
  campaignName: string;
}

export interface BulkSchedulerRunLog {
  id: string;
  trigger: "scheduled" | "manual";
  runKey?: string;
  status: "running" | "completed" | "error" | "skipped";
  startedAt: string;
  completedAt?: string;
  fetchedContacts: number;
  selectedContacts: number;
  queuedLeads: number;
  skippedLeads: number;
  ghlNotesLogged: number;
  summary: string;
  errors: string[];
}

interface BulkSchedulerState {
  settings: BulkSchedulerSettings;
  runs: BulkSchedulerRunLog[];
  executedRunKeys: string[];
  running: boolean;
  lastTickAt?: string;
  updatedAt: string;
}

interface RunCampaignOptions {
  trigger: "scheduled" | "manual";
  runKey?: string;
}

const STATE_KEY = "bulk_campaign_scheduler";
const MAX_RUN_LOGS = 120;
const MAX_RUN_KEYS = 400;
let dbFallbackWarned = false;
let memoryFallbackWarned = false;
let memoryState: BulkSchedulerState | undefined;
let tickTimer: NodeJS.Timeout | undefined;
let runInFlight = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clampHour(value: number): number {
  return Math.min(23, Math.max(0, Math.trunc(value)));
}

function normalizeScheduleHours(value: unknown): number[] {
  if (!Array.isArray(value)) return [9, 11, 14];
  const parsed = value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .map((item) => clampHour(item as number));
  const unique = Array.from(new Set(parsed)).sort((a, b) => a - b);
  return unique.length ? unique : [9, 11, 14];
}

function defaultSettings(): BulkSchedulerSettings {
  return {
    enabled: config.bulkSchedulerEnabled,
    timezone: config.bulkSchedulerTimezone || "America/New_York",
    scheduleHours: normalizeScheduleHours(config.bulkSchedulerHours),
    runWindowMinutes: Math.min(15, Math.max(1, Math.trunc(config.bulkSchedulerRunWindowMinutes || 4))),
    batchSize: Math.min(200, Math.max(1, Math.trunc(config.bulkSchedulerBatchSize || 50))),
    samplePoolSize: Math.min(2000, Math.max(50, Math.trunc(config.bulkSchedulerSamplePoolSize || 400))),
    campaignName: (config.bulkSchedulerCampaignName || "GHL Random Daily Campaign").trim()
  };
}

function createEmptyState(): BulkSchedulerState {
  return {
    settings: defaultSettings(),
    runs: [],
    executedRunKeys: [],
    running: false,
    updatedAt: nowIso()
  };
}

function normalizeState(state: BulkSchedulerState): BulkSchedulerState {
  const defaults = defaultSettings();
  state.settings = {
    enabled: typeof state.settings?.enabled === "boolean" ? state.settings.enabled : defaults.enabled,
    timezone: (state.settings?.timezone || defaults.timezone).trim() || "America/New_York",
    scheduleHours: normalizeScheduleHours(state.settings?.scheduleHours || defaults.scheduleHours),
    runWindowMinutes: Math.min(
      15,
      Math.max(1, Math.trunc(Number(state.settings?.runWindowMinutes || defaults.runWindowMinutes)))
    ),
    batchSize: Math.min(200, Math.max(1, Math.trunc(Number(state.settings?.batchSize || defaults.batchSize)))),
    samplePoolSize: Math.min(
      2000,
      Math.max(50, Math.trunc(Number(state.settings?.samplePoolSize || defaults.samplePoolSize)))
    ),
    campaignName: (state.settings?.campaignName || defaults.campaignName).trim() || defaults.campaignName
  };
  state.runs = Array.isArray(state.runs) ? state.runs.slice(-MAX_RUN_LOGS) : [];
  state.executedRunKeys = Array.isArray(state.executedRunKeys) ? state.executedRunKeys.slice(-MAX_RUN_KEYS) : [];
  state.running = Boolean(state.running);
  state.updatedAt = state.updatedAt || nowIso();
  return state;
}

function getMemoryState(): BulkSchedulerState {
  if (!memoryState) memoryState = createEmptyState();
  return clone(memoryState);
}

async function ensureStateFile(): Promise<void> {
  await fs.mkdir(path.dirname(config.bulkSchedulerStatePath), { recursive: true });
  try {
    await fs.access(config.bulkSchedulerStatePath);
  } catch {
    await fs.writeFile(config.bulkSchedulerStatePath, JSON.stringify(createEmptyState(), null, 2), "utf8");
  }
}

async function acquireLock(timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    try {
      const handle = await fs.open(config.bulkSchedulerLockPath, "wx");
      await handle.close();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Could not acquire bulk scheduler lock after ${timeoutMs}ms`);
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(config.bulkSchedulerLockPath);
  } catch {
    // no-op
  }
}

async function loadState(): Promise<BulkSchedulerState> {
  if (hasDatabaseState()) {
    try {
      const parsed = await loadDbJsonState<BulkSchedulerState>(STATE_KEY, createEmptyState());
      return normalizeState(parsed);
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[BULK-SCHEDULER] Database unavailable; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  try {
    await ensureStateFile();
    const raw = await fs.readFile(config.bulkSchedulerStatePath, "utf8");
    const parsed = normalizeState(JSON.parse(raw) as BulkSchedulerState);
    memoryState = clone(parsed);
    return parsed;
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[BULK-SCHEDULER] Filesystem unavailable; using in-memory state.", error);
      memoryFallbackWarned = true;
    }
    return getMemoryState();
  }
}

async function saveState(state: BulkSchedulerState): Promise<void> {
  state.updatedAt = nowIso();
  if (hasDatabaseState()) {
    try {
      await saveDbJsonState(STATE_KEY, state);
      return;
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[BULK-SCHEDULER] Database save failed; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  try {
    const tempPath = `${config.bulkSchedulerStatePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tempPath, config.bulkSchedulerStatePath);
    memoryState = clone(state);
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[BULK-SCHEDULER] Filesystem save failed; using in-memory state only.", error);
      memoryFallbackWarned = true;
    }
    memoryState = clone(state);
  }
}

async function withBulkSchedulerState<T>(fn: (state: BulkSchedulerState) => Promise<T> | T): Promise<T> {
  if (hasDatabaseState()) {
    try {
      return withDbJsonState(STATE_KEY, createEmptyState, async (state) => {
        normalizeState(state as BulkSchedulerState);
        return fn(state as BulkSchedulerState);
      });
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[BULK-SCHEDULER] Database transaction failed; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  let lockAcquired = false;
  try {
    await acquireLock();
    lockAcquired = true;
    const state = await loadState();
    const out = await fn(state);
    await saveState(state);
    return out;
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[BULK-SCHEDULER] Lock/filesystem unavailable; using in-memory state.", error);
      memoryFallbackWarned = true;
    }
    const state = getMemoryState();
    const out = await fn(state);
    state.updatedAt = nowIso();
    memoryState = clone(state);
    return out;
  } finally {
    if (lockAcquired) await releaseLock();
  }
}

function dtf(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function getZonedParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = dtf(timezone).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((part) => part.type === type)?.value || "0";
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute")
  };
}

function runKeyFromParts(parts: { year: number; month: number; day: number; hour: number }): string {
  const y = String(parts.year).padStart(4, "0");
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  const h = String(parts.hour).padStart(2, "0");
  return `${y}-${m}-${d}@${h}`;
}

function upcomingRunLabels(settings: BulkSchedulerSettings, count = 6): string[] {
  const labels: string[] = [];
  const timezone = settings.timezone || "America/New_York";
  const now = new Date();
  for (let dayOffset = 0; dayOffset < 4 && labels.length < count; dayOffset += 1) {
    for (const hour of settings.scheduleHours) {
      const candidate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      candidate.setHours(hour, 0, 0, 0);
      if (candidate.getTime() <= now.getTime()) continue;
      labels.push(
        new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          month: "short",
          day: "2-digit",
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        }).format(candidate)
      );
      if (labels.length >= count) break;
    }
  }
  return labels;
}

function shuffle<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function splitName(value?: string): { firstName?: string; lastName?: string } {
  const raw = (value || "").trim();
  if (!raw) return {};
  const parts = raw.split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined
  };
}

async function queueContactsAsLeads(
  runId: string,
  settings: BulkSchedulerSettings,
  contacts: GhlSmartListContact[]
): Promise<{ queued: Array<{ lead: Lead; contact: GhlSmartListContact }>; skipped: number }> {
  const queued: Array<{ lead: Lead; contact: GhlSmartListContact }> = [];

  const result = await withState((state) => {
    const activePhones = new Set(
      Object.values(state.leads)
        .filter((lead) => lead.status === "queued" || lead.status === "retry" || lead.status === "dialing")
        .map((lead) => normalizePhone(lead.phone || ""))
        .filter((value): value is string => Boolean(value))
    );

    let skipped = 0;
    for (const contact of contacts) {
      const normalizedPhone = normalizePhone(contact.phone || "");
      if (!normalizedPhone) {
        skipped += 1;
        continue;
      }
      if (activePhones.has(normalizedPhone)) {
        skipped += 1;
        continue;
      }

      const name = splitName(contact.name);
      const firstName = contact.firstName || name.firstName;
      const lastName = contact.lastName || name.lastName;
      const company = contact.companyName || contact.name || firstName || "GHL Contact";
      const createdAt = nowIso();
      const leadId = `ghl-random-${hashShort(`${runId}|${contact.id || normalizedPhone}`)}`;

      const lead: Lead = {
        id: leadId,
        phone: normalizedPhone,
        firstName,
        lastName,
        company,
        email: contact.email || undefined,
        timezone: contact.timezone || config.defaultTimezone,
        campaign: settings.campaignName || config.campaignName,
        sourceFile: "ghl-random-scheduler",
        sourceRow: queued.length + 1,
        findings: "Queued by GHL random bulk scheduler",
        notes: `Scheduler run ${runId}; source=ghl-random; ghlContactId=${contact.id || ""}`,
        optIn: true,
        dnc: false,
        status: "queued",
        attempts: 0,
        ghlContactId: contact.id || undefined,
        createdAt,
        updatedAt: createdAt
      };

      state.leads[lead.id] = lead;
      queued.push({ lead: { ...lead }, contact });
      activePhones.add(normalizedPhone);
    }
    return { skipped };
  });

  return { queued, skipped: result.skipped };
}

async function applyQueuedNotesToGhl(
  runId: string,
  trigger: "scheduled" | "manual",
  queued: Array<{ lead: Lead; contact: GhlSmartListContact }>
): Promise<{ logged: number; failures: number }> {
  let logged = 0;
  let failures = 0;
  for (const row of queued) {
    const noteResult = await logBulkSchedulerQueuedContact({
      lead: row.lead,
      runId,
      trigger,
      contactId: row.contact.id,
      queuedAt: nowIso()
    });
    if (noteResult.synced) {
      logged += 1;
      if (noteResult.contactId) {
        await withState((state) => {
          const lead = state.leads[row.lead.id];
          if (!lead) return;
          lead.ghlContactId = noteResult.contactId;
          lead.ghlSyncedAt = nowIso();
          lead.ghlLastError = undefined;
          lead.updatedAt = nowIso();
        });
      }
    } else {
      failures += 1;
      await withState((state) => {
        const lead = state.leads[row.lead.id];
        if (!lead) return;
        lead.ghlLastError = noteResult.error || "Unknown GHL scheduler log error";
        lead.updatedAt = nowIso();
      });
    }
  }
  return { logged, failures };
}

function appendRunLog(state: BulkSchedulerState, log: BulkSchedulerRunLog): void {
  state.runs.push(log);
  if (state.runs.length > MAX_RUN_LOGS) {
    state.runs = state.runs.slice(state.runs.length - MAX_RUN_LOGS);
  }
}

async function executeRun(options: RunCampaignOptions): Promise<BulkSchedulerRunLog> {
  const state = await loadState();
  const settings = normalizeState(state).settings;
  const runId = `bulk-${Date.now()}-${hashShort(`${Math.random()}`)}`;
  const startedAt = nowIso();

  const runLog: BulkSchedulerRunLog = {
    id: runId,
    trigger: options.trigger,
    runKey: options.runKey,
    status: "running",
    startedAt,
    fetchedContacts: 0,
    selectedContacts: 0,
    queuedLeads: 0,
    skippedLeads: 0,
    ghlNotesLogged: 0,
    summary: "Run started.",
    errors: []
  };

  await withBulkSchedulerState((row) => {
    row.running = true;
    appendRunLog(row, runLog);
  });

  try {
    const pageLimit = Math.min(200, Math.max(50, Math.trunc(settings.samplePoolSize / 3)));
    const maxPages = Math.min(20, Math.max(1, Math.ceil(settings.samplePoolSize / pageLimit)));
    const fetchResult = await fetchLocationContacts({ pageLimit, maxPages });
    const withPhone = fetchResult.contacts.filter((contact) => Boolean(normalizePhone(contact.phone || "")));
    const pool = shuffle(withPhone).slice(0, settings.samplePoolSize);
    const selected = shuffle(pool).slice(0, settings.batchSize);

    runLog.fetchedContacts = fetchResult.contacts.length;
    runLog.selectedContacts = selected.length;

    if (!selected.length) {
      runLog.status = "skipped";
      runLog.summary = "No contacts with valid phone numbers available from GHL.";
      runLog.completedAt = nowIso();
      return runLog;
    }

    const queuedResult = await queueContactsAsLeads(runId, settings, selected);
    runLog.queuedLeads = queuedResult.queued.length;
    runLog.skippedLeads = queuedResult.skipped;

    const ghlResult = await applyQueuedNotesToGhl(runId, options.trigger, queuedResult.queued);
    runLog.ghlNotesLogged = ghlResult.logged;
    if (ghlResult.failures > 0) {
      runLog.errors.push(`Failed to log ${ghlResult.failures} GHL notes.`);
    }

    runLog.status = "completed";
    runLog.summary = `Fetched ${runLog.fetchedContacts}, selected ${runLog.selectedContacts}, queued ${runLog.queuedLeads}, GHL notes ${runLog.ghlNotesLogged}.`;
    runLog.completedAt = nowIso();
    runtimeInfo("scheduler", "bulk scheduler run completed", {
      runId,
      trigger: options.trigger,
      queuedLeads: runLog.queuedLeads,
      notesLogged: runLog.ghlNotesLogged
    });
    return runLog;
  } catch (error) {
    runLog.status = "error";
    runLog.completedAt = nowIso();
    runLog.summary = "Bulk scheduler run failed.";
    runLog.errors.push(String(error).slice(0, 500));
    runtimeError("scheduler", "bulk scheduler run failed", error, {
      runId,
      trigger: options.trigger
    });
    return runLog;
  } finally {
    await withBulkSchedulerState((row) => {
      row.running = false;
      const target = row.runs.find((item) => item.id === runId);
      if (target) {
        Object.assign(target, runLog);
      } else {
        appendRunLog(row, runLog);
      }
    });
  }
}

export async function runBulkSchedulerCampaign(trigger: "scheduled" | "manual", runKey?: string): Promise<BulkSchedulerRunLog> {
  if (runInFlight) {
    return {
      id: `bulk-skip-${Date.now()}`,
      trigger,
      runKey,
      status: "skipped",
      startedAt: nowIso(),
      completedAt: nowIso(),
      fetchedContacts: 0,
      selectedContacts: 0,
      queuedLeads: 0,
      skippedLeads: 0,
      ghlNotesLogged: 0,
      summary: "Run skipped because another scheduler run is already in progress.",
      errors: []
    };
  }

  runInFlight = true;
  try {
    return await executeRun({ trigger, runKey });
  } finally {
    runInFlight = false;
  }
}

async function markRunKeyExecuted(runKey: string): Promise<boolean> {
  return withBulkSchedulerState((state) => {
    if (state.executedRunKeys.includes(runKey)) {
      return false;
    }
    state.executedRunKeys.push(runKey);
    if (state.executedRunKeys.length > MAX_RUN_KEYS) {
      state.executedRunKeys = state.executedRunKeys.slice(state.executedRunKeys.length - MAX_RUN_KEYS);
    }
    return true;
  });
}

async function tickScheduler(): Promise<void> {
  const state = await loadState();
  const settings = normalizeState(state).settings;
  await withBulkSchedulerState((row) => {
    row.lastTickAt = nowIso();
  });

  if (!settings.enabled) return;
  const parts = getZonedParts(new Date(), settings.timezone);
  if (!settings.scheduleHours.includes(parts.hour)) return;
  if (parts.minute >= settings.runWindowMinutes) return;

  const runKey = runKeyFromParts(parts);
  const firstRunner = await markRunKeyExecuted(runKey);
  if (!firstRunner) return;
  await runBulkSchedulerCampaign("scheduled", runKey);
}

export async function startBulkCampaignScheduler(): Promise<void> {
  if (tickTimer) return;
  const intervalMs = Math.max(10, config.bulkSchedulerTickSeconds) * 1000;
  tickTimer = setInterval(() => {
    tickScheduler().catch((error) => {
      runtimeError("scheduler", "bulk scheduler tick failed", error);
    });
  }, intervalMs);

  tickScheduler().catch((error) => {
    runtimeError("scheduler", "bulk scheduler initial tick failed", error);
  });
  runtimeInfo("scheduler", "bulk scheduler loop started", {
    intervalMs,
    timezone: config.bulkSchedulerTimezone,
    hours: config.bulkSchedulerHours
  });
}

export async function getBulkCampaignSchedulerStatus(): Promise<{
  settings: BulkSchedulerSettings;
  running: boolean;
  lastTickAt?: string;
  runs: BulkSchedulerRunLog[];
  upcomingRunTimes: string[];
}> {
  const state = await loadState();
  return {
    settings: state.settings,
    running: state.running || runInFlight,
    lastTickAt: state.lastTickAt,
    runs: state.runs.slice().reverse(),
    upcomingRunTimes: upcomingRunLabels(state.settings, 6)
  };
}

export async function updateBulkCampaignSchedulerSettings(
  patch: Partial<BulkSchedulerSettings>
): Promise<BulkSchedulerSettings> {
  let updated: BulkSchedulerSettings = defaultSettings();
  await withBulkSchedulerState((state) => {
    state.settings = {
      ...state.settings,
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : state.settings.enabled,
      timezone: (patch.timezone || state.settings.timezone).trim() || "America/New_York",
      scheduleHours: normalizeScheduleHours(patch.scheduleHours || state.settings.scheduleHours),
      runWindowMinutes:
        typeof patch.runWindowMinutes === "number"
          ? Math.min(15, Math.max(1, Math.trunc(patch.runWindowMinutes)))
          : state.settings.runWindowMinutes,
      batchSize:
        typeof patch.batchSize === "number"
          ? Math.min(200, Math.max(1, Math.trunc(patch.batchSize)))
          : state.settings.batchSize,
      samplePoolSize:
        typeof patch.samplePoolSize === "number"
          ? Math.min(2000, Math.max(50, Math.trunc(patch.samplePoolSize)))
          : state.settings.samplePoolSize,
      campaignName: (patch.campaignName || state.settings.campaignName).trim() || state.settings.campaignName
    };
    updated = { ...state.settings };
  });
  runtimeInfo("scheduler", "bulk scheduler settings updated", { ...updated });
  return updated;
}

export async function setBulkCampaignSchedulerEnabled(enabled: boolean): Promise<BulkSchedulerSettings> {
  return updateBulkCampaignSchedulerSettings({ enabled });
}
