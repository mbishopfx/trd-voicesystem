import { config } from "./config.js";
import { nowIso } from "./utils.js";

export interface VapiCreditGuardStatus {
  enabled: boolean;
  minCredits: number;
  fetchOk: boolean;
  stopDialing: boolean;
  reason: string;
  checkedAt: string;
  availableCredits?: number;
  sourceEndpoint?: string;
  statusCode?: number;
}

let cachedStatus: VapiCreditGuardStatus | undefined;
let cachedAtMs = 0;
let inFlight: Promise<VapiCreditGuardStatus> | undefined;

const CREDIT_ENDPOINTS = ["/account", "/account/usage", "/billing", "/subscription", "/organization", "/org", "/org/usage"];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function pickByPath(root: unknown, path: string[]): number | undefined {
  let node = root;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return asFiniteNumber(node);
}

function walkForCreditNumbers(root: unknown): number[] {
  const out: number[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const lowered = key.toLowerCase();
      const numeric = asFiniteNumber(value);
      if (numeric !== undefined && (lowered.includes("credit") || lowered === "balance")) {
        out.push(numeric);
      }
      visit(value);
    }
  };
  visit(root);
  return out;
}

function extractRemainingCredits(payload: unknown): number | undefined {
  const preferredPaths = [
    ["remainingCredits"],
    ["creditsRemaining"],
    ["availableCredits"],
    ["creditBalance"],
    ["billing", "remainingCredits"],
    ["billing", "creditsRemaining"],
    ["usage", "remainingCredits"],
    ["usage", "creditsRemaining"],
    ["account", "remainingCredits"],
    ["account", "creditsRemaining"],
    ["subscription", "remainingCredits"],
    ["subscription", "creditsRemaining"]
  ];

  for (const row of preferredPaths) {
    const value = pickByPath(payload, row);
    if (value !== undefined) return value;
  }

  const discovered = walkForCreditNumbers(payload);
  if (discovered.length === 0) return undefined;
  return discovered[0];
}

async function fetchJson(url: string, apiKey: string): Promise<{ status: number; payload?: unknown }> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    }
  });
  const raw = await response.text();
  if (!raw.trim()) return { status: response.status, payload: {} };
  try {
    return { status: response.status, payload: JSON.parse(raw) };
  } catch {
    return { status: response.status, payload: { raw } };
  }
}

async function fetchCreditsNow(): Promise<VapiCreditGuardStatus> {
  const checkedAt = nowIso();
  const minCredits = config.vapiMinCreditsToDial;
  if (!config.vapiCreditGuardEnabled) {
    return {
      enabled: false,
      minCredits,
      fetchOk: false,
      stopDialing: false,
      reason: "disabled",
      checkedAt
    };
  }
  if (!config.vapiApiKey) {
    return {
      enabled: true,
      minCredits,
      fetchOk: false,
      stopDialing: false,
      reason: "missing VAPI_API_KEY",
      checkedAt
    };
  }

  let lastStatus = 0;
  for (const endpoint of CREDIT_ENDPOINTS) {
    const target = `${config.vapiBaseUrl}${endpoint}`;
    try {
      const response = await fetchJson(target, config.vapiApiKey);
      lastStatus = response.status;
      if (response.status === 404) continue;
      if (response.status < 200 || response.status >= 300) continue;

      const availableCredits = extractRemainingCredits(response.payload);
      if (availableCredits === undefined) continue;
      return {
        enabled: true,
        minCredits,
        fetchOk: true,
        stopDialing: availableCredits <= minCredits,
        reason: availableCredits <= minCredits ? "credits at or below threshold" : "ok",
        checkedAt,
        availableCredits,
        sourceEndpoint: endpoint,
        statusCode: response.status
      };
    } catch {
      // Try next known endpoint.
    }
  }

  return {
    enabled: true,
    minCredits,
    fetchOk: false,
    stopDialing: false,
    reason: lastStatus ? `credit endpoint unavailable (status=${lastStatus})` : "credit endpoint unavailable",
    checkedAt,
    statusCode: lastStatus || undefined
  };
}

export async function getVapiCreditGuardStatus(force = false): Promise<VapiCreditGuardStatus> {
  const ttlMs = config.vapiCreditCheckIntervalSeconds * 1000;
  if (!force && cachedStatus && Date.now() - cachedAtMs < ttlMs) return cachedStatus;
  if (!force && inFlight) return inFlight;

  inFlight = (async () => {
    const status = await fetchCreditsNow();
    cachedStatus = status;
    cachedAtMs = Date.now();
    return status;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}

