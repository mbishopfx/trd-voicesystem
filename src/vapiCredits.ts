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

interface CreditProbeRequest {
  endpoint: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  authMode?: "private" | "public";
}

const BASE_CREDIT_PROBES: CreditProbeRequest[] = [
  { endpoint: "/subscription" },
  { endpoint: "/account" },
  { endpoint: "/account/usage" },
  { endpoint: "/billing" },
  { endpoint: "/billing/subscription" },
  { endpoint: "/organization" },
  { endpoint: "/organization/usage" },
  { endpoint: "/org" },
  { endpoint: "/org/usage" }
];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    ["credits"],
    ["credit"],
    ["wallet", "credits"],
    ["wallet", "creditBalance"],
    ["remainingCredits"],
    ["creditsRemaining"],
    ["availableCredits"],
    ["creditBalance"],
    ["subscription", "credits"],
    ["subscription", "creditBalance"],
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

function extractOrgId(payload: unknown): string {
  const tryNode = (node: unknown): string => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        const found = tryNode(entry);
        if (found) return found;
      }
      return "";
    }
    if (!isObject(node)) return "";
    const direct = asString(node.orgId);
    if (direct) return direct;

    const preferredCollections = [
      node.assistants,
      node.data,
      node.items,
      node.results,
      node.result
    ];
    for (const child of preferredCollections) {
      const found = tryNode(child);
      if (found) return found;
    }

    for (const value of Object.values(node)) {
      const found = tryNode(value);
      if (found) return found;
    }
    return "";
  };
  return tryNode(payload);
}

function buildCreditProbeRequests(orgId: string): CreditProbeRequest[] {
  const scopedHeaders = orgId
    ? {
        "x-org-id": orgId,
        "x-organization-id": orgId
      }
    : undefined;

  const scoped: CreditProbeRequest[] = orgId
    ? [
        { endpoint: `/subscription/${encodeURIComponent(orgId)}` },
        { endpoint: `/org/${encodeURIComponent(orgId)}` },
        { endpoint: `/org/${encodeURIComponent(orgId)}`, authMode: "public" },
        { endpoint: `/organization/${encodeURIComponent(orgId)}` },
        { endpoint: `/organization/${encodeURIComponent(orgId)}`, authMode: "public" },
        { endpoint: "/subscription", headers: scopedHeaders },
        { endpoint: "/organization", headers: scopedHeaders },
        { endpoint: "/org", headers: scopedHeaders },
        { endpoint: "/org", headers: scopedHeaders, authMode: "public" }
      ]
    : [];

  return [
    ...scoped,
    ...BASE_CREDIT_PROBES.map((probe) => ({
      ...probe,
      headers: { ...(probe.headers || {}), ...(scopedHeaders || {}) }
    }))
  ];
}

async function fetchJson(
  url: string,
  privateKey: string,
  publicKey: string,
  probe?: CreditProbeRequest
): Promise<{ status: number; payload?: unknown }> {
  const hasBody = probe?.body !== undefined;
  const method = probe?.method || (hasBody ? "POST" : "GET");
  const authToken = probe?.authMode === "public" ? publicKey || privateKey : privateKey;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      Accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(probe?.headers || {})
    },
    ...(hasBody ? { body: JSON.stringify(probe?.body) } : {})
  });
  const raw = await response.text();
  if (!raw.trim()) return { status: response.status, payload: {} };
  try {
    return { status: response.status, payload: JSON.parse(raw) };
  } catch {
    return { status: response.status, payload: { raw } };
  }
}

async function discoverOrgId(apiKey: string): Promise<string> {
  const discoveryProbes: CreditProbeRequest[] = [{ endpoint: "/assistant?limit=1" }, { endpoint: "/assistant" }];
  for (const probe of discoveryProbes) {
    try {
      const response = await fetchJson(`${config.vapiBaseUrl}${probe.endpoint}`, apiKey, config.vapiPublicKey, probe);
      if (response.status < 200 || response.status >= 300) continue;
      const orgId = extractOrgId(response.payload);
      if (orgId) return orgId;
    } catch {
      // Ignore discovery errors and continue credit probes without org scope.
    }
  }
  return "";
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

  const orgId = await discoverOrgId(config.vapiApiKey);
  const probes = buildCreditProbeRequests(orgId);

  let lastStatus = 0;
  let sawUnsupported = false;
  for (const probe of probes) {
    const target = `${config.vapiBaseUrl}${probe.endpoint}`;
    try {
      const response = await fetchJson(target, config.vapiApiKey, config.vapiPublicKey, probe);
      lastStatus = response.status;
      if (response.status === 404 || response.status === 401) {
        sawUnsupported = true;
        continue;
      }
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
        sourceEndpoint: probe.endpoint,
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
    reason: sawUnsupported
      ? "credit endpoint unsupported for current Vapi key/account"
      : lastStatus
      ? `credit endpoint unavailable (status=${lastStatus})`
      : "credit endpoint unavailable",
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
