import { config } from "../config.js";

export class VapiPhoneNumberError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = "VapiPhoneNumberError";
  }
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveApiKey(override?: string): string {
  const key = safeString(override) || config.vapiApiKey;
  if (!key) {
    throw new Error("Missing Vapi private key");
  }
  return key;
}

function apiBase(baseUrl?: string): string {
  return safeString(baseUrl) || config.vapiBaseUrl;
}

async function requestJson(
  path: string,
  options: {
    apiKey?: string;
    baseUrl?: string;
    method?: string;
    body?: Record<string, unknown>;
  }
): Promise<Record<string, unknown> | Array<Record<string, unknown>>> {
  const response = await fetch(`${apiBase(options.baseUrl)}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${resolveApiKey(options.apiKey)}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new VapiPhoneNumberError(`Vapi phone-number request failed (${response.status})`, response.status, raw);
  }

  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown> | Array<Record<string, unknown>>;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
}

function toObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export async function listVapiPhoneNumbers(input?: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<Array<Record<string, unknown>>> {
  const parsed = await requestJson("/phone-number", input || {});
  if (Array.isArray(parsed)) return asArray(parsed);
  return asArray((parsed as Record<string, unknown>).phoneNumbers);
}

export async function getVapiPhoneNumber(
  phoneNumberId: string,
  input?: {
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<Record<string, unknown>> {
  const parsed = await requestJson(`/phone-number/${phoneNumberId}`, input || {});
  return Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
}

export async function updateVapiPhoneNumber(
  phoneNumberId: string,
  patch: Record<string, unknown>,
  input?: {
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<Record<string, unknown>> {
  const parsed = await requestJson(`/phone-number/${phoneNumberId}`, {
    ...(input || {}),
    method: "PATCH",
    body: patch
  });
  return Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
}

export async function attachAssistantToVapiPhoneNumber(
  phoneNumberId: string,
  assistantId: string,
  input?: {
    apiKey?: string;
    baseUrl?: string;
    serverUrl?: string;
  }
): Promise<Record<string, unknown>> {
  const serverUrl = safeString(input?.serverUrl);
  const minimalPatch: Record<string, unknown> = { assistantId };
  if (serverUrl) {
    minimalPatch.server = { url: serverUrl };
  }

  try {
    return await updateVapiPhoneNumber(phoneNumberId, minimalPatch, input);
  } catch (firstError) {
    const current = await getVapiPhoneNumber(phoneNumberId, input);
    const fallbackPatch: Record<string, unknown> = {
      assistantId,
      provider: safeString(current.provider),
      number: safeString(current.number),
      credentialId: safeString(current.credentialId),
      name: safeString(current.name)
    };

    const server = toObject(current.server);
    if (serverUrl || Object.keys(server).length > 0) {
      fallbackPatch.server = serverUrl ? { ...server, url: serverUrl } : server;
    }

    fallbackPatch.fallbackDestination = toObject(current.fallbackDestination);

    try {
      return await updateVapiPhoneNumber(phoneNumberId, fallbackPatch, input);
    } catch (secondError) {
      if (secondError instanceof VapiPhoneNumberError) {
        throw secondError;
      }
      if (firstError instanceof VapiPhoneNumberError) {
        throw firstError;
      }
      throw secondError;
    }
  }
}
