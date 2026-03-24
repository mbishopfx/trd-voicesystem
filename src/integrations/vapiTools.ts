import { config } from "../config.js";

export class VapiToolError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = "VapiToolError";
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
    throw new VapiToolError(`Vapi request failed (${response.status})`, response.status, raw);
  }

  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown> | Array<Record<string, unknown>>;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((v): v is Record<string, unknown> => Boolean(v && typeof v === "object"));
  }
  return [];
}

export async function listVapiTools(input?: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<Array<Record<string, unknown>>> {
  const parsed = await requestJson("/tool", input || {});
  if (Array.isArray(parsed)) return asArray(parsed);

  const direct = (parsed as Record<string, unknown>).tools;
  return asArray(direct);
}

export async function createVapiTool(
  tool: Record<string, unknown>,
  input?: {
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<Record<string, unknown>> {
  const parsed = await requestJson("/tool", {
    ...(input || {}),
    method: "POST",
    body: tool
  });

  return Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
}

export async function getVapiTool(
  toolId: string,
  input?: {
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<Record<string, unknown>> {
  const parsed = await requestJson(`/tool/${toolId}`, input || {});
  return Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
}

export async function updateVapiTool(
  toolId: string,
  patch: Record<string, unknown>,
  input?: {
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<Record<string, unknown>> {
  const parsed = await requestJson(`/tool/${toolId}`, {
    ...(input || {}),
    method: "PATCH",
    body: patch
  });

  return Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
}

export async function deleteVapiTool(
  toolId: string,
  input?: {
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<Record<string, unknown>> {
  const parsed = await requestJson(`/tool/${toolId}`, {
    ...(input || {}),
    method: "DELETE"
  });

  return Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
}

export async function getVapiAssistant(
  assistantId: string,
  input?: {
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<Record<string, unknown>> {
  const parsed = await requestJson(`/assistant/${assistantId}`, input || {});
  return Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
}

function toolIdsFromAssistant(assistant: Record<string, unknown>): string[] {
  const model = assistant.model;
  if (!model || typeof model !== "object") return [];
  const toolIds = (model as Record<string, unknown>).toolIds;
  if (!Array.isArray(toolIds)) return [];
  return toolIds
    .map((id) => (typeof id === "string" ? id.trim() : ""))
    .filter(Boolean);
}

function assistantModelFromAssistant(assistant: Record<string, unknown>): Record<string, unknown> {
  const model = assistant.model;
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return {};
  }
  return { ...(model as Record<string, unknown>) };
}

export async function setAssistantToolIds(
  assistantId: string,
  toolIds: string[],
  input?: {
    apiKey?: string;
    baseUrl?: string;
    mode?: "replace" | "append" | "remove";
  }
): Promise<{ assistant: Record<string, unknown>; toolIds: string[] }> {
  const mode = input?.mode || "replace";
  const current = await getVapiAssistant(assistantId, input);
  const currentIds = toolIdsFromAssistant(current);
  const currentModel = assistantModelFromAssistant(current);

  let nextIds = toolIds;
  if (mode !== "replace") {
    if (mode === "append") {
      nextIds = [...new Set([...currentIds, ...toolIds])];
    } else {
      const remove = new Set(toolIds);
      nextIds = currentIds.filter((id) => !remove.has(id));
    }
  }

  const updated = await requestJson(`/assistant/${assistantId}`, {
    ...(input || {}),
    method: "PATCH",
    body: {
      model: {
        ...currentModel,
        toolIds: nextIds
      }
    }
  });

  const assistant = Array.isArray(updated) ? (updated[0] || {}) : updated;
  return {
    assistant,
    toolIds: nextIds
  };
}
