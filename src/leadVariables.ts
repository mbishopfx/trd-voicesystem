import type { Lead } from "./types.js";

export type LeadVariableRow = Record<string, unknown>;

const VARIABLE_FIELD_KEYS = new Set([
  "variables",
  "variablevalues",
  "templatevariables",
  "voicevariables",
  "additionalvariables",
  "customvariables"
]);

export function normalizeVariableKey(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const CANONICAL_CAMPAIGN_VARIABLE_KEYS: Record<string, string> = {
  firstname: "leadFirstName",
  first: "leadFirstName",
  leadfirstname: "leadFirstName",
  lastname: "leadLastName",
  leadlastname: "leadLastName",
  company: "leadCompany",
  companyname: "leadCompany",
  business: "leadCompany",
  businessname: "leadCompany",
  leadcompany: "leadCompany",
  findings: "leadFindings",
  leadfindings: "leadFindings",
  bookingurl: "bookingUrl",
  bookinglink: "bookingUrl",
  calendlyurl: "calendlyUrl",
  calendlylink: "calendlyUrl",
  googlecalendarurl: "googleCalendarUrl",
  campaign: "campaignName",
  campaignname: "campaignName"
};

function toText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function parseLooseVariableString(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const chunks = input
    .split(/\r?\n|[;|]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const separatorIndex = chunk.includes("=") ? chunk.indexOf("=") : chunk.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = chunk.slice(0, separatorIndex).trim();
    const value = chunk.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;
    out[key] = value;
  }

  return out;
}

function parseVariablePayload(value: unknown): Record<string, string> {
  if (!value) return {};

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, raw]) => [key, toText(raw)])
        .filter((entry): entry is [string, string] => Boolean(entry[0].trim()) && Boolean(entry[1]))
    );
  }

  if (typeof value !== "string") return {};
  const raw = value.trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parseVariablePayload(parsed);
    }
  } catch {
    // ignore and fall through
  }

  return parseLooseVariableString(raw);
}

function put(out: Record<string, string>, key: string, value: unknown): void {
  const normalizedKey = normalizeVariableKey(key);
  const normalizedValue = toText(value);
  if (!normalizedKey || !normalizedValue) return;
  out[normalizedKey] = normalizedValue;
}

export function resolveCampaignVariableKey(token: string): string {
  const normalized = normalizeVariableKey(token);
  if (!normalized) return "";
  return CANONICAL_CAMPAIGN_VARIABLE_KEYS[normalized] || normalized;
}

export function normalizeCampaignMessageTemplate(
  template: string,
  options?: { limit?: number; literalReplacements?: Record<string, string> }
): string {
  const source = String(template || "").trim();
  if (!source) return "";

  const literalReplacements = Object.fromEntries(
    Object.entries(options?.literalReplacements || {})
      .map(([key, value]) => [normalizeVariableKey(key), toText(value)])
      .filter((entry): entry is [string, string] => Boolean(entry[0]) && Boolean(entry[1]))
  );

  const cleaned = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/[*_#>`~]/g, " ")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*•]+\s*/, ""))
    .map((line) => line.replace(/^\d+[.)]\s*/, ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^(system message|system prompt|pitch|script|message|opener|opening line|custom message)\s*[:\-]\s*/i, "")
    .trim();

  const replaceToken = (rawToken: string): string => {
    const normalized = normalizeVariableKey(rawToken);
    if (!normalized) return "";
    if (literalReplacements[normalized]) return literalReplacements[normalized];
    const resolved = resolveCampaignVariableKey(rawToken);
    return resolved ? `{{${resolved}}}` : "";
  };

  const withBraces = cleaned.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, token) => replaceToken(String(token || "")));
  const normalized = withBraces.replace(/\[\s*([a-zA-Z0-9_ -]+?)\s*\]/g, (_match, token) =>
    replaceToken(String(token || ""))
  );

  const limit = Math.max(40, Math.trunc(Number(options?.limit || 320)));
  return normalized.replace(/\s+/g, " ").trim().slice(0, limit).trim();
}

export function extractLeadVariables(
  row: LeadVariableRow,
  lead?: Partial<Lead>,
  extras?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(row || {})) {
    put(out, key, value);
    if (VARIABLE_FIELD_KEYS.has(normalizeVariableKey(key))) {
      const nested = parseVariablePayload(value);
      for (const [nestedKey, nestedValue] of Object.entries(nested)) {
        put(out, nestedKey, nestedValue);
      }
    }
  }

  const firstName = toText(lead?.firstName);
  const lastName = toText(lead?.lastName);
  const company = toText(lead?.company);
  const email = toText(lead?.email);
  const phone = toText(lead?.phone);
  const campaign = toText(lead?.campaign);
  const timezone = toText(lead?.timezone);

  put(out, "firstName", firstName);
  put(out, "first_name", firstName);
  put(out, "leadFirstName", firstName);
  put(out, "lastName", lastName);
  put(out, "last_name", lastName);
  put(out, "leadLastName", lastName);
  put(out, "fullName", [firstName, lastName].filter(Boolean).join(" "));
  put(out, "full_name", [firstName, lastName].filter(Boolean).join(" "));
  put(out, "company", company);
  put(out, "company_name", company);
  put(out, "business", company);
  put(out, "business_name", company);
  put(out, "leadCompany", company);
  put(out, "email", email);
  put(out, "phone", phone);
  put(out, "campaign", campaign);
  put(out, "campaign_name", campaign);
  put(out, "campaignName", campaign);
  put(out, "timezone", timezone);

  for (const [key, value] of Object.entries(extras || {})) {
    put(out, key, value);
  }

  return out;
}
