import { Buffer } from "node:buffer";
import { config, resolvedBookingUrl } from "../config.js";
import { normalizePhone } from "../phone.js";
import { runtimeError, runtimeInfo } from "../runtimeLogs.js";

export interface WinSmsResult {
  sid?: string;
  status: number;
  body: string;
}

export interface TwilioMessageRecord {
  sid?: string;
  status?: string;
  to?: string;
  from?: string;
  body?: string;
  direction?: string;
  errorCode?: string;
  errorMessage?: string;
  dateCreated?: string;
  dateSent?: string;
  dateUpdated?: string;
  uri?: string;
}

function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => values[key] || "");
}

export function isTwilioSmsConfigured(): boolean {
  return Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioPhoneNumber);
}

export function canSendWinSms(): boolean {
  return config.winSmsEnabled && isTwilioSmsConfigured() && Boolean(resolvedBookingUrl());
}

function twilioAuthHeader(): string {
  return Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseTwilioMessage(input: Record<string, unknown>): TwilioMessageRecord {
  return {
    sid: asString(input.sid),
    status: asString(input.status),
    to: asString(input.to),
    from: asString(input.from),
    body: asString(input.body),
    direction: asString(input.direction),
    errorCode: input.error_code !== undefined && input.error_code !== null ? String(input.error_code) : undefined,
    errorMessage: asString(input.error_message),
    dateCreated: asString(input.date_created),
    dateSent: asString(input.date_sent),
    dateUpdated: asString(input.date_updated),
    uri: asString(input.uri)
  };
}

async function twilioGet(path: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
  if (!isTwilioSmsConfigured()) {
    throw new Error("Twilio SMS is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)");
  }

  const qs = query ? new URLSearchParams(query).toString() : "";
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}${path}${qs ? `?${qs}` : ""}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Basic ${twilioAuthHeader()}`,
      Accept: "application/json"
    }
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Twilio API GET failed (${response.status}): ${body}`.slice(0, 800));
  }

  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error("Twilio API returned invalid JSON");
  }
}

async function sendTwilioSms(input: { to: string; body: string }): Promise<WinSmsResult> {
  if (!isTwilioSmsConfigured()) {
    throw new Error("Twilio SMS is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)");
  }

  const to = normalizePhone(input.to);
  if (!to) {
    throw new Error("Invalid destination phone number");
  }

  const from = normalizePhone(config.twilioPhoneNumber);
  if (!from) {
    throw new Error("Invalid TWILIO_PHONE_NUMBER");
  }

  const text = String(input.body || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1400);

  if (!text) {
    throw new Error("SMS body is empty");
  }

  runtimeInfo("twilio", "Twilio SMS send attempt", {
    to,
    from,
    chars: text.length
  });

  const form = new URLSearchParams({ To: to, From: from, Body: text });
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${twilioAuthHeader()}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const body = await response.text();
  if (!response.ok) {
    runtimeError("twilio", "Twilio SMS send failed", undefined, {
      to,
      from,
      status: response.status,
      bodyPreview: body.slice(0, 180)
    });
    throw new Error(`Twilio SMS failed (${response.status}): ${body}`.slice(0, 800));
  }

  let sid: string | undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    sid = asString(parsed.sid);
  } catch {
    sid = undefined;
  }

  runtimeInfo("twilio", "Twilio SMS sent", {
    to,
    from,
    sid: sid || "",
    status: response.status
  });

  return {
    sid,
    status: response.status,
    body
  };
}

export async function sendSmsMessage(input: { to: string; body: string }): Promise<WinSmsResult> {
  return sendTwilioSms(input);
}

export async function sendWinBookingSms(input: { to: string; firstName?: string; campaign?: string }): Promise<WinSmsResult> {
  if (!config.winSmsEnabled) {
    throw new Error("WIN_SMS_ENABLED is false");
  }

  if (!isTwilioSmsConfigured()) {
    throw new Error("Twilio SMS is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)");
  }

  const bookingUrl = resolvedBookingUrl();
  if (!bookingUrl) {
    throw new Error("No booking URL configured (BOOKING_URL_* env)");
  }

  const text = applyTemplate(config.winSmsTemplate, {
    firstName: input.firstName || "",
    bookingUrl,
    campaignName: input.campaign || config.campaignName
  });
  return sendTwilioSms({ to: input.to, body: text });
}

export async function listTwilioMessages(input?: {
  to?: string;
  from?: string;
  pageSize?: number;
}): Promise<TwilioMessageRecord[]> {
  const query: Record<string, string> = {};
  if (input?.to) {
    const to = normalizePhone(input.to);
    if (to) query.To = to;
  }
  if (input?.from) {
    const from = normalizePhone(input.from);
    if (from) query.From = from;
  }
  const pageSize = Math.max(1, Math.min(100, Math.trunc(input?.pageSize || 20)));
  query.PageSize = String(pageSize);

  const data = await twilioGet("/Messages.json", query);
  const rows = Array.isArray(data.messages)
    ? data.messages.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
  return rows.map((row) => parseTwilioMessage(row));
}

export async function fetchTwilioMessageBySid(sid: string): Promise<TwilioMessageRecord> {
  const cleanSid = sid.trim();
  if (!cleanSid) {
    throw new Error("sid is required");
  }
  const data = await twilioGet(`/Messages/${encodeURIComponent(cleanSid)}.json`);
  return parseTwilioMessage(data);
}
