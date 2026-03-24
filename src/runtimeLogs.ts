export interface RuntimeLogEntry {
  id: number;
  at: string;
  ts: number;
  level: "info" | "error";
  scope: "worker" | "dialer" | "ingest" | "webhook" | "server" | "ghl" | "agent";
  message: string;
}

const MAX_LOGS = 5000;
let nextId = 1;
const logs: RuntimeLogEntry[] = [];

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
  return row;
}

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
