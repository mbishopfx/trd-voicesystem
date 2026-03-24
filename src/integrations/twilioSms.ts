import { Buffer } from "node:buffer";
import { config, resolvedBookingUrl } from "../config.js";
import { normalizePhone } from "../phone.js";

export interface WinSmsResult {
  sid?: string;
  status: number;
  body: string;
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

  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");
  const form = new URLSearchParams({ To: to, From: from, Body: text });
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Twilio SMS failed (${response.status}): ${body}`.slice(0, 800));
  }

  let sid: string | undefined;
  try {
    const parsed = JSON.parse(body) as { sid?: string };
    sid = parsed.sid;
  } catch {
    sid = undefined;
  }

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
