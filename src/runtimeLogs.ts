import fs from "node:fs";
import path from "node:path";

export interface RuntimeLogEntry {
  id: number;
  at: string;
  ts: number;
  level: "info" | "error";
  scope: "worker" | "dialer" | "ingest" | "webhook" | "server" | "ghl" | "agent" | "twilio" | "vapi";
  message: string;
}

const MAX_LOGS = 5000;
let nextId = 1;
const logs: RuntimeLogEntry[] = [];
const LOG_DIR = path.resolve(process.cwd(), "data", "state");
const LOG_FILE = path.resolve(LOG_DIR, "runtime-logs.jsonl");

function ensureLogDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // no-op
  }
}

function loadPersistedLogs(): void {
  try {
    ensureLogDir();
    if (!fs.existsSync(LOG_FILE)) return;
    const raw = fs.readFileSync(LOG_FILE, "utf8");
    if (!raw.trim()) return;

    const loaded: RuntimeLogEntry[] = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as RuntimeLogEntry;
        } catch {
          return undefined;
        }
      })
      .filter((row): row is RuntimeLogEntry => Boolean(row && typeof row.id === "number" && typeof row.ts === "number"));

    if (loaded.length === 0) return;
    const recent = loaded.slice(-MAX_LOGS);
    logs.push(...recent);
    const maxId = recent.reduce((max, row) => Math.max(max, row.id), 0);
    nextId = Math.max(nextId, maxId + 1);
  } catch {
    // no-op
  }
}

function now(): { at: string; ts: number } {
  const ts = Date.now();
  return { at: new Date(ts).toISOString(), ts };
}

function push(entry: Omit<RuntimeLogEntry, "id" | "at" | "ts">): RuntimeLogEntry {
  const stamp = now();
  const row: RuntimeLogEntry = {
    id: nextId,
    at: stamp.at,
    ts: stamp.ts,
    ...entry
  };
  nextId += 1;
  logs.push(row);
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS);
  }
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    // no-op
  }
  return row;
}

loadPersistedLogs();

export function runtimeInfo(
  scope: RuntimeLogEntry["scope"],
  message: string,
  details?: Record<string, unknown>
): RuntimeLogEntry {
  const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  const line = `[${scope.toUpperCase()}] ${message}${suffix}`;
  console.log(line);
  return push({ level: "info", scope, message: `${message}${suffix}` });
}

export function runtimeError(
  scope: RuntimeLogEntry["scope"],
  message: string,
  error?: unknown,
  details?: Record<string, unknown>
): RuntimeLogEntry {
  const normalized = error ? String(error) : "";
  const extra = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  const fullMessage = normalized ? `${message}: ${normalized}${extra}` : `${message}${extra}`;
  console.error(`[${scope.toUpperCase()}] ${fullMessage}`);
  return push({ level: "error", scope, message: fullMessage });
}

export function listRuntimeLogs(opts?: {
  scope?: RuntimeLogEntry["scope"];
  afterTs?: number;
  limit?: number;
}): RuntimeLogEntry[] {
  const scope = opts?.scope;
  const afterTs = Number.isFinite(opts?.afterTs) ? (opts?.afterTs as number) : undefined;
  const limit = Math.max(1, Math.min(1000, Math.trunc(opts?.limit || 200)));

  const filtered = logs.filter((entry) => {
    if (scope && entry.scope !== scope) return false;
    if (afterTs !== undefined && entry.ts <= afterTs) return false;
    return true;
  });

  if (filtered.length <= limit) return filtered;
  return filtered.slice(filtered.length - limit);
}

export function latestRuntimeLogTs(scope?: RuntimeLogEntry["scope"]): number {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const row = logs[i];
    if (!scope || row.scope === scope) return row.ts;
  }
  return 0;
}
