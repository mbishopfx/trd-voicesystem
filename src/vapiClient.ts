import { config, resolvedBookingUrl } from "./config.js";
import type { Lead, VapiCallResult } from "./types.js";
import { runtimeError, runtimeInfo } from "./runtimeLogs.js";

export class HttpError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = "HttpError";
  }
}

async function requestCall(
  payload: Record<string, unknown>,
  credentials: { baseUrl: string; apiKey: string }
): Promise<VapiCallResult> {
  const response = await fetch(`${credentials.baseUrl}/call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new HttpError(`Vapi call create failed (${response.status})`, response.status, rawText);
  }

  const parsed = JSON.parse(rawText) as { id?: string } & Record<string, unknown>;
  if (!parsed.id) {
    throw new Error("Vapi response did not include call ID");
  }

  return { id: parsed.id, raw: parsed };
}

export type VoiceProfile = "female" | "male";

export interface OutboundCallOptions {
  apiKey?: string;
  baseUrl?: string;
  assistantId?: string;
  phoneNumberId?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  voiceProfile?: VoiceProfile;
  additionalVariables?: Record<string, string>;
}

function resolveAssistantId(options?: OutboundCallOptions): string {
  if (options?.assistantId) return options.assistantId;
  if (options?.voiceProfile === "female" && config.vapiAssistantIdFemale) return config.vapiAssistantIdFemale;
  if (options?.voiceProfile === "male" && config.vapiAssistantIdMale) return config.vapiAssistantIdMale;
  if (config.vapiAssistantId) return config.vapiAssistantId;
  if (config.vapiAssistantIdFemale) return config.vapiAssistantIdFemale;
  if (config.vapiAssistantIdMale) return config.vapiAssistantIdMale;
  throw new Error("Missing assistantId. Set VAPI_ASSISTANT_ID or profile-specific assistant IDs.");
}

function resolvePhoneNumberId(options?: OutboundCallOptions): string {
  if (options?.phoneNumberId) return options.phoneNumberId;
  if (config.vapiPhoneNumberId) return config.vapiPhoneNumberId;
  return "";
}

function resolveTransientPhoneNumber(
  options?: OutboundCallOptions
): { twilioPhoneNumber: string; twilioAccountSid: string; twilioAuthToken: string } | undefined {
  const twilioPhoneNumber = options?.twilioPhoneNumber || config.twilioPhoneNumber;
  const twilioAccountSid = options?.twilioAccountSid || config.twilioAccountSid;
  const twilioAuthToken = options?.twilioAuthToken || config.twilioAuthToken;

  if (!twilioPhoneNumber || !twilioAccountSid || !twilioAuthToken) {
    return undefined;
  }

  return { twilioPhoneNumber, twilioAccountSid, twilioAuthToken };
}

function resolveApiKey(options?: OutboundCallOptions): string {
  if (options?.apiKey) return options.apiKey;
  if (config.vapiApiKey) return config.vapiApiKey;
  throw new Error("Missing Vapi API key. Set VAPI_API_KEY.");
}

export async function createOutboundCall(lead: Lead, options?: OutboundCallOptions): Promise<VapiCallResult> {
  const apiKey = resolveApiKey(options);
  const assistantId = resolveAssistantId(options);
  const phoneNumberId = resolvePhoneNumberId(options);
  const transientPhoneNumber = resolveTransientPhoneNumber(options);
  const baseUrl = options?.baseUrl || config.vapiBaseUrl;

  if (!phoneNumberId && !transientPhoneNumber) {
    throw new Error(
      "Missing phone number config. Set VAPI_PHONE_NUMBER_ID or TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER."
    );
  }

  const variableValues: Record<string, string> = {
    leadFirstName: lead.firstName || "",
    leadCompany: lead.company || "",
    leadFindings: lead.findings || "",
    bookingUrl: resolvedBookingUrl(),
    calendlyUrl: config.bookingUrlCalendly,
    googleCalendarUrl: config.bookingUrlGoogleCalendar,
    campaignName: lead.campaign,
    ...(options?.additionalVariables || {})
  };

  const voicemailDetection: Record<string, unknown> = {
    provider: config.voicemailDetectionProvider || "vapi",
    backoffPlan: {
      maxRetries: config.voicemailDetectionMaxRetries,
      startAtSeconds: config.voicemailDetectionStartAtSeconds,
      frequencySeconds: config.voicemailDetectionFrequencySeconds
    },
    beepMaxAwaitSeconds: config.voicemailBeepMaxAwaitSeconds
  };

  const assistantOverrides: Record<string, unknown> = {
    maxDurationSeconds: config.maxCallSeconds,
    variableValues,
    voicemailDetection
  };

  assistantOverrides.firstMessageMode = config.assistantWaitsForUser
    ? "assistant-waits-for-user"
    : "assistant-speaks-first";

  const payload: Record<string, unknown> = {
    assistantId,
    customer: {
      number: lead.phone,
      name: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.company || undefined
    },
    assistantOverrides,
    metadata: {
      leadId: lead.id,
      campaign: lead.campaign,
      sourceFile: lead.sourceFile,
      voiceProfile: options?.voiceProfile || "default"
    }
  };

  if (phoneNumberId) {
    payload.phoneNumberId = phoneNumberId;
  } else if (transientPhoneNumber) {
    payload.phoneNumber = transientPhoneNumber;
  }

  const credentials = { baseUrl, apiKey };
  runtimeInfo("vapi", "Outbound call create requested", {
    leadId: lead.id,
    phone: lead.phone,
    assistantId,
    hasPhoneNumberId: Boolean(phoneNumberId),
    hasTransientPhoneNumber: Boolean(transientPhoneNumber)
  });

  try {
    const created = await requestCall(payload, credentials);
    runtimeInfo("vapi", "Outbound call create success", {
      leadId: lead.id,
      callId: created.id
    });
    return created;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 400) {
      runtimeError("vapi", "Outbound call create failed", error, {
        leadId: lead.id,
        phone: lead.phone
      });
      throw error;
    }

    runtimeInfo("vapi", "Retrying outbound call create without maxDurationSeconds", {
      leadId: lead.id,
      status: error.status
    });
    const relaxedOverrides: Record<string, unknown> = { ...assistantOverrides };
    delete relaxedOverrides.maxDurationSeconds;

    const fallbackPayload: Record<string, unknown> = {
      ...payload,
      assistantOverrides: relaxedOverrides
    };

    try {
      const created = await requestCall(fallbackPayload, credentials);
      runtimeInfo("vapi", "Outbound call create success via relaxed override", {
        leadId: lead.id,
        callId: created.id
      });
      return created;
    } catch (fallbackError) {
      if (!(fallbackError instanceof HttpError) || fallbackError.status !== 400) {
        runtimeError("vapi", "Outbound call create failed on relaxed override", fallbackError, {
          leadId: lead.id,
          phone: lead.phone
        });
        throw fallbackError;
      }

      runtimeInfo("vapi", "Retrying outbound call create with minimal override", {
        leadId: lead.id,
        status: fallbackError.status
      });
      const minimalPayload: Record<string, unknown> = {
        ...payload,
        assistantOverrides: {
          variableValues
        }
      };

      const created = await requestCall(minimalPayload, credentials);
      runtimeInfo("vapi", "Outbound call create success via minimal override", {
        leadId: lead.id,
        callId: created.id
      });
      return created;
    }
  }
}
