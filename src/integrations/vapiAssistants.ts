import { config } from "../config.js";
import type { AgentTemplate } from "../agentTemplates.js";
import { compileTemplatePrompt } from "../agentTemplates.js";

export interface CreatedVapiAssistant {
  id: string;
  name?: string;
  raw: Record<string, unknown>;
}

export class VapiAssistantError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = "VapiAssistantError";
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

function endpoint(baseUrl?: string): string {
  return `${safeString(baseUrl) || config.vapiBaseUrl}/assistant`;
}

function assistantName(template: AgentTemplate): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 10);
  const base = template.name.replace(/\s+/g, " ").trim();
  const maxBase = 40 - (stamp.length + 1);
  const clipped = base.slice(0, Math.max(8, maxBase));
  return `${clipped}-${stamp}`.slice(0, 40);
}

export async function listVapiAssistants(input?: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<Array<Record<string, unknown>>> {
  const apiKey = resolveApiKey(input?.apiKey);

  const response = await fetch(endpoint(input?.baseUrl), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    }
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new VapiAssistantError(`Vapi assistant list failed (${response.status})`, response.status, rawText);
  }

  const parsed = JSON.parse(rawText) as unknown;
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;

  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (Array.isArray(p.assistants)) {
      return p.assistants as Array<Record<string, unknown>>;
    }
  }

  return [];
}

export async function createVapiAssistantFromTemplate(
  template: AgentTemplate,
  input?: {
    apiKey?: string;
    baseUrl?: string;
    serverUrl?: string;
    toolIds?: string[];
    assistantName?: string;
  }
): Promise<CreatedVapiAssistant> {
  const apiKey = resolveApiKey(input?.apiKey);
  const compiled = compileTemplatePrompt(template);

  const payload: Record<string, unknown> = {
    name: safeString(input?.assistantName) || assistantName(template),
    firstMessage: template.openingScript,
    model: {
      provider: "openai",
      model: "gpt-4.1-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: compiled.prompt
        }
      ]
    },
    firstMessageMode: config.assistantWaitsForUser ? "assistant-waits-for-user" : undefined,
    voicemailDetection: {
      provider: config.voicemailDetectionProvider,
      backoffPlan: {
        maxRetries: config.voicemailDetectionMaxRetries,
        startAtSeconds: config.voicemailDetectionStartAtSeconds,
        frequencySeconds: config.voicemailDetectionFrequencySeconds
      },
      beepMaxAwaitSeconds: config.voicemailBeepMaxAwaitSeconds
    },
    metadata: {
      templateId: template.id,
      templateName: template.name,
      qualityScore: compiled.quality.score,
      rulePacks: template.rulePacks
    }
  };

  const toolIds = input?.toolIds?.filter((id) => typeof id === "string" && id.trim()) || [];
  if (toolIds.length > 0) {
    (payload.model as Record<string, unknown>).toolIds = [...new Set(toolIds)];
  }

  const serverUrl = safeString(input?.serverUrl);
  if (serverUrl) {
    payload.server = { url: serverUrl };
  }

  const response = await fetch(endpoint(input?.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new VapiAssistantError(`Vapi assistant create failed (${response.status})`, response.status, rawText);
  }

  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  const id = safeString(parsed.id);
  if (!id) {
    throw new Error("Vapi assistant response missing id");
  }

  return {
    id,
    name: safeString(parsed.name),
    raw: parsed
  };
}
