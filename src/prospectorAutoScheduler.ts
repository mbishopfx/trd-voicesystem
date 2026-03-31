import { config } from "./config.js";
import { startProspectorRun, type ProspectorRun } from "./prospector.js";
import { runtimeError, runtimeInfo } from "./runtimeLogs.js";
import { nowIso } from "./utils.js";

type SchedulerTrigger = "scheduled" | "manual";

export interface ProspectorAutoSchedulerSettings {
  enabled: boolean;
  timezone: string;
  scheduleHours: number[];
  runWindowMinutes: number;
  icpPool: string[];
  cityPool: string[];
  state: string;
}

export interface ProspectorAutoSchedulerRunLog {
  id: string;
  trigger: SchedulerTrigger;
  runKey?: string;
  status: "running" | "completed" | "error" | "skipped";
  startedAt: string;
  completedAt?: string;
  icp?: string;
  city?: string;
  state?: string;
  discovered?: number;
  prospectorRunId?: string;
  summary: string;
  errors: string[];
}

const MAX_RUN_LOGS = 120;
const MAX_EXECUTED_RUN_KEYS = 500;

let tickTimer: NodeJS.Timeout | undefined;
let runInFlight = false;
let lastTickAt: string | undefined;
const runs: ProspectorAutoSchedulerRunLog[] = [];
const executedRunKeys: string[] = [];
let settings: ProspectorAutoSchedulerSettings = {
  enabled: config.prospectorAutoSchedulerEnabled,
  timezone: config.prospectorAutoSchedulerTimezone || "America/New_York",
  scheduleHours: [...new Set(config.prospectorAutoSchedulerHours)].sort((a, b) => a - b),
  runWindowMinutes: Math.min(15, Math.max(1, Math.trunc(config.prospectorAutoSchedulerRunWindowMinutes || 5))),
  icpPool: config.prospectorAutoSchedulerIcpPool.filter(Boolean),
  cityPool: config.prospectorAutoSchedulerNjCities.filter(Boolean),
  state: "NJ"
};

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toPositiveHour(value: number): number {
  return Math.max(0, Math.min(23, Math.trunc(value)));
}

function normalizeHours(values: number[]): number[] {
  return [...new Set(values.map((value) => toPositiveHour(value)))].sort((a, b) => a - b);
}

function chooseRandom(values: string[]): string | undefined {
  if (!values.length) return undefined;
  const index = Math.floor(Math.random() * values.length);
  return values[index];
}

function addRunLog(run: ProspectorAutoSchedulerRunLog): void {
  runs.unshift(run);
  if (runs.length > MAX_RUN_LOGS) {
    runs.splice(MAX_RUN_LOGS);
  }
}

function getZonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const out: Record<string, number> = {};
  for (const part of parts) {
    if (!part.type || part.type === "literal") continue;
    const parsed = Number(part.value);
    if (Number.isFinite(parsed)) out[part.type] = parsed;
  }
  return {
    year: out.year || date.getUTCFullYear(),
    month: out.month || date.getUTCMonth() + 1,
    day: out.day || date.getUTCDate(),
    hour: out.hour || 0,
    minute: out.minute || 0
  };
}

function runKeyFromParts(parts: { year: number; month: number; day: number; hour: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}-${String(
    parts.hour
  ).padStart(2, "0")}`;
}

function markRunKey(runKey: string): boolean {
  if (executedRunKeys.includes(runKey)) return false;
  executedRunKeys.push(runKey);
  if (executedRunKeys.length > MAX_EXECUTED_RUN_KEYS) {
    executedRunKeys.splice(0, executedRunKeys.length - MAX_EXECUTED_RUN_KEYS);
  }
  return true;
}

async function executeRun(trigger: SchedulerTrigger, runKey?: string): Promise<ProspectorAutoSchedulerRunLog> {
  if (runInFlight) {
    const skipped: ProspectorAutoSchedulerRunLog = {
      id: randomId("prospector-auto"),
      trigger,
      runKey,
      status: "skipped",
      startedAt: nowIso(),
      completedAt: nowIso(),
      summary: "Skipped because another prospector auto run is already in progress.",
      errors: []
    };
    addRunLog(skipped);
    return skipped;
  }

  runInFlight = true;
  const startedAt = nowIso();
  const runLog: ProspectorAutoSchedulerRunLog = {
    id: randomId("prospector-auto"),
    trigger,
    runKey,
    status: "running",
    startedAt,
    summary: "Prospector auto run started.",
    errors: []
  };
  addRunLog(runLog);

  try {
    const icp = chooseRandom(settings.icpPool);
    const city = chooseRandom(settings.cityPool);
    if (!icp || !city) {
      runLog.status = "error";
      runLog.completedAt = nowIso();
      runLog.summary = "Prospector auto scheduler is missing ICP pool or NJ city pool.";
      runLog.errors.push("Missing scheduler ICP/city pool configuration.");
      return runLog;
    }

    runLog.icp = icp;
    runLog.city = city;
    runLog.state = settings.state;
    const run: ProspectorRun = await startProspectorRun({
      icp,
      city,
      state: settings.state
    });

    runLog.prospectorRunId = run.id;
    runLog.discovered = run.discovered;
    runLog.status = run.status === "failed" ? "error" : "completed";
    runLog.summary = `Auto prospector run ${run.status}. icp=${icp}, market=${city}, ${settings.state}, discovered=${run.discovered}.`;
    if (run.status === "failed" && run.notes) {
      runLog.errors.push(run.notes.slice(0, 500));
    }
    runLog.completedAt = nowIso();

    runtimeInfo("scheduler", "prospector auto run completed", {
      runKey: runKey || "",
      trigger,
      icp,
      city,
      state: settings.state,
      discovered: run.discovered,
      runId: run.id,
      status: run.status
    });
    return runLog;
  } catch (error) {
    runLog.status = "error";
    runLog.completedAt = nowIso();
    runLog.summary = "Prospector auto run failed.";
    runLog.errors.push(String(error).slice(0, 500));
    runtimeError("scheduler", "prospector auto run failed", error, {
      runKey: runKey || "",
      trigger,
      icp: runLog.icp || "",
      city: runLog.city || "",
      state: settings.state
    });
    return runLog;
  } finally {
    runInFlight = false;
  }
}

async function tickScheduler(): Promise<void> {
  lastTickAt = nowIso();
  if (!settings.enabled) return;
  const parts = getZonedParts(new Date(), settings.timezone);
  if (!settings.scheduleHours.includes(parts.hour)) return;
  if (parts.minute >= settings.runWindowMinutes) return;
  const runKey = runKeyFromParts(parts);
  if (!markRunKey(runKey)) return;
  await executeRun("scheduled", runKey);
}

export async function startProspectorAutoScheduler(): Promise<void> {
  if (tickTimer) return;
  settings = {
    ...settings,
    enabled: config.prospectorAutoSchedulerEnabled,
    timezone: config.prospectorAutoSchedulerTimezone || "America/New_York",
    scheduleHours: normalizeHours(config.prospectorAutoSchedulerHours),
    runWindowMinutes: Math.min(15, Math.max(1, Math.trunc(config.prospectorAutoSchedulerRunWindowMinutes || 5))),
    icpPool: config.prospectorAutoSchedulerIcpPool.filter(Boolean),
    cityPool: config.prospectorAutoSchedulerNjCities.filter(Boolean)
  };
  const intervalMs = Math.max(10, config.prospectorAutoSchedulerTickSeconds) * 1000;
  tickTimer = setInterval(() => {
    tickScheduler().catch((error) => {
      runtimeError("scheduler", "prospector auto scheduler tick failed", error);
    });
  }, intervalMs);

  tickScheduler().catch((error) => {
    runtimeError("scheduler", "prospector auto scheduler initial tick failed", error);
  });

  runtimeInfo("scheduler", "prospector auto scheduler loop started", {
    intervalMs,
    timezone: settings.timezone,
    scheduleHours: settings.scheduleHours,
    runWindowMinutes: settings.runWindowMinutes,
    enabled: settings.enabled
  });
}

export function getProspectorAutoSchedulerStatus(): {
  settings: ProspectorAutoSchedulerSettings;
  running: boolean;
  lastTickAt?: string;
  runs: ProspectorAutoSchedulerRunLog[];
} {
  return {
    settings: { ...settings },
    running: runInFlight,
    lastTickAt,
    runs: runs.map((run) => ({ ...run }))
  };
}

export function setProspectorAutoSchedulerEnabled(enabled: boolean): ProspectorAutoSchedulerSettings {
  settings.enabled = enabled;
  runtimeInfo("scheduler", "prospector auto scheduler enabled updated", { enabled });
  return { ...settings };
}

export async function runProspectorAutoSchedulerNow(): Promise<ProspectorAutoSchedulerRunLog> {
  return executeRun("manual");
}

