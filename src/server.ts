import crypto from "node:crypto";
import fs from "node:fs/promises";
import express, { type Request, type Response } from "express";
import path from "node:path";
import { config, effectiveCps, resolvedBookingUrl } from "./config.js";
import { ingestOnce } from "./ingest.js";
import { inferOutcome, hasPromptInjectionSignals } from "./outcomes.js";
import { normalizePhone } from "./phone.js";
import { withState } from "./store.js";
import type { Lead } from "./types.js";
import { hashShort, isMainModule, nowIso } from "./utils.js";
import { createOutboundCall, type VoiceProfile } from "./vapiClient.js";
import { fetchSmartListContacts, isGhlConfigured, syncLeadToGhl } from "./integrations/ghl.js";
import { listProspectorRuns, startProspectorRun } from "./prospector.js";
import { generateReadyProspectSites } from "./generation.js";
import { createProspectScreenshots } from "./screenshots.js";
import { markProspectReadyForCall } from "./handoff.js";
import { releaseProspectToQueue } from "./queueRelease.js";
import { getProspectLeadById } from "./prospectTest.js";
import { createProspectVisionTemplate } from "./prospectTemplate.js";
import { createTonyDemoTemplate } from "./tonyDemoTemplate.js";
import { deployGeneratedProspects } from "./deploy.js";
import {
  runProspectorPhase2,
  runProspectorPhase3,
  runProspectorPhase4,
  runProspectorPhase5,
  runProspectorPipeline
} from "./prospectorPhases.js";
import { canWriteProspectorRecords, listProspectorPhaseRecords } from "./prospectorRecords.js";
import { computeAnalyticsSummary } from "./analytics.js";
import {
  exportRetargetBuckets,
  noContactFromOutcome,
  retargetBucketFromOutcome,
  summarizeRetargetBuckets
} from "./retargetBuckets.js";
import {
  createVapiAssistantFromTemplate,
  listVapiAssistants,
  VapiAssistantError
} from "./integrations/vapiAssistants.js";
import {
  createVapiTool,
  deleteVapiTool,
  listVapiTools,
  setAssistantToolIds,
  updateVapiTool,
  VapiToolError
} from "./integrations/vapiTools.js";
import {
  buildVapiAssistantDraft,
  compileTemplatePrompt,
  createDefaultTemplate,
  normalizeTemplateInput,
  RULE_PACKS,
  type AgentTemplate
} from "./agentTemplates.js";
import { TOOL_CATALOG } from "./toolCatalog.js";
import { loadTemplateState, withTemplateState } from "./templateStore.js";
import { getDialerCooldownRemainingMs, resetStuckDialingLeads, setDialerPostCallCooldown } from "./worker.js";
import {
  canSendWinSms,
  fetchTwilioMessageBySid,
  isTwilioSmsConfigured,
  listTwilioMessages,
  sendProspectorFollowUpSms,
  sendSmsMessage,
  sendWinBookingSms
} from "./integrations/twilioSms.js";
import {
  inboundPhasePlan,
  loadInboundProfile,
  saveInboundProfilePatch,
  type InboundProfile
} from "./inboundStore.js";
import {
  attachAssistantToVapiPhoneNumber,
  getVapiPhoneNumber,
  listVapiPhoneNumbers,
  VapiPhoneNumberError
} from "./integrations/vapiPhoneNumbers.js";
import {
  createCalendlyInvitee,
  listCalendlyEventTypeAvailableTimes,
  listCalendlyEventTypes,
  normalizeCalendlyEventTypeUri
} from "./integrations/calendly.js";
import { generateManualCallDraft, isGeminiConfigured } from "./integrations/gemini.js";
import { latestRuntimeLogTs, listRuntimeLogs, runtimeError, runtimeInfo } from "./runtimeLogs.js";
import {
  getBulkCampaignSchedulerStatus,
  runBulkSchedulerCampaign,
  setBulkCampaignSchedulerEnabled,
  updateBulkCampaignSchedulerSettings
} from "./bulkCampaignScheduler.js";
import { getVapiCreditGuardStatus } from "./vapiCredits.js";
import {
  deleteVoiceProfile,
  getVoicesDashboard,
  runVoiceBatchCampaign,
  runVoiceCsvCampaign,
  spinUpAssistantForProfile,
  upsertVoiceProfile
} from "./voices.js";

type RawBodyRequest = Request & { rawBody?: string };
let reconcileLoopStarted = false;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function asOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function asOptionalInt(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.trunc(parsed);
  return Math.min(max, Math.max(min, rounded));
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  return [];
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const nextKey = key.trim();
    if (!nextKey) continue;
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string") {
      out[nextKey] = raw;
      continue;
    }
    if (typeof raw === "number" || typeof raw === "boolean") {
      out[nextKey] = String(raw);
    }
  }
  return out;
}

function sanitizeCsvFilename(input: string, fallback = "upload.csv"): string {
  const base = path.basename(input || fallback).trim() || fallback;
  const replaced = base.replace(/[^a-zA-Z0-9._-]/g, "-");
  const collapsed = replaced.replace(/-+/g, "-").replace(/^\.+/, "");
  const out = collapsed.toLowerCase().endsWith(".csv") ? collapsed : `${collapsed}.csv`;
  return out || fallback;
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  if (!text.includes(",") && !text.includes('"') && !text.includes("\n") && !text.includes("\r")) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function rowsToCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.join(",")];
  for (const row of rows) {
    const cells = headers.map((header) => csvCell(row[header]));
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

function summarizeLeadQueue(leads: Lead[]): Record<string, number> {
  return leads.reduce<Record<string, number>>((acc, lead) => {
    const key = lead.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

interface VapiToolInvocation {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

interface VapiToolExecutionResult {
  toolCallId: string;
  result: unknown;
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseToolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    return parseJsonObject(value) || {};
  }
  return {};
}

function parseVapiToolInvocations(payload: Record<string, unknown>): VapiToolInvocation[] {
  const message = getVapiMessage(payload);
  const byId = new Map<string, VapiToolInvocation>();

  const directList = Array.isArray(message.toolCallList) ? message.toolCallList : [];
  for (const item of directList) {
    const row = asObject(item);
    if (!row) continue;
    const toolCallId = safeString(row.id);
    const name = safeString(row.name);
    if (!toolCallId || !name) continue;
    byId.set(toolCallId, {
      toolCallId,
      name,
      args: parseToolArgs(row.arguments)
    });
  }

  const embeddedList = Array.isArray(message.toolWithToolCallList) ? message.toolWithToolCallList : [];
  for (const item of embeddedList) {
    const row = asObject(item);
    if (!row) continue;
    const toolCall = asObject(row.toolCall);
    const functionNode = asObject(toolCall?.function);
    const toolCallId = safeString(toolCall?.id);
    const name = safeString(functionNode?.name) || safeString(row.name);
    if (!toolCallId || !name) continue;
    byId.set(toolCallId, {
      toolCallId,
      name,
      args: parseToolArgs(functionNode?.parameters)
    });
  }

  return Array.from(byId.values());
}

function requestBaseUrl(req: Request): string {
  const protoHeader = safeString(req.header("x-forwarded-proto")) || req.protocol || "http";
  const proto = protoHeader.split(",")[0].trim() || "http";
  const host = safeString(req.header("x-forwarded-host")) || safeString(req.get("host")) || "localhost:3000";
  return `${proto}://${host}`;
}

function parseIsoTimestamp(value: unknown): string | undefined {
  const raw = safeString(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

function splitFullName(name?: string): { firstName?: string; lastName?: string } {
  const full = safeString(name);
  if (!full) return {};
  const pieces = full.split(/\s+/).filter(Boolean);
  if (pieces.length === 0) return {};
  if (pieces.length === 1) return { firstName: pieces[0] };
  return {
    firstName: pieces.slice(0, -1).join(" "),
    lastName: pieces[pieces.length - 1]
  };
}

function extractPhoneFromToolPayload(payload: Record<string, unknown>): string | undefined {
  const message = getVapiMessage(payload);
  const call = asObject(message.call) || asObject(payload.call);
  if (!call) return undefined;

  const customer = asObject(call.customer);
  const assistant = asObject(call.assistant);
  const candidate =
    safeString(call.phoneNumber) ||
    safeString(call.phone) ||
    safeString(call.to) ||
    safeString(call.from) ||
    safeString(customer?.number) ||
    safeString(customer?.phoneNumber) ||
    safeString(customer?.phone) ||
    safeString(assistant?.number) ||
    safeString(assistant?.phoneNumber) ||
    safeString(assistant?.phone);
  return candidate ? normalizePhone(candidate) || candidate : undefined;
}

function extractLeadIdFromToolPayload(payload: Record<string, unknown>): string | undefined {
  const message = getVapiMessage(payload);
  const call = asObject(message.call) || asObject(payload.call);
  if (!call) return undefined;
  const metadata = asObject(call.metadata);
  return safeString(metadata?.leadId) || safeString(call.leadId);
}

function extractFirstNameFromToolPayload(payload: Record<string, unknown>): string | undefined {
  const message = getVapiMessage(payload);
  const call = asObject(message.call) || asObject(payload.call);
  const customer = asObject(call?.customer);
  const full = safeString(customer?.name) || safeString((asObject(message.customer) || {}).name);
  if (!full) return undefined;
  return full.split(/\s+/).filter(Boolean)[0];
}

function getVapiMessage(payload: Record<string, unknown>): Record<string, unknown> {
  const msg = asObject(payload.message);
  return msg || payload;
}

function getCallId(payload: Record<string, unknown>): string | undefined {
  const message = getVapiMessage(payload);

  const direct = safeString(message.callId) || safeString(payload.callId);
  if (direct) return direct;

  const messageCall = asObject(message.call);
  if (messageCall) {
    const maybeId = safeString(messageCall.id);
    if (maybeId) return maybeId;
  }

  const payloadCall = asObject(payload.call);
  if (payloadCall) {
    const maybeId = safeString(payloadCall.id);
    if (maybeId) return maybeId;
  }

  return safeString(message.id) || safeString(payload.id);
}

function getEventType(payload: Record<string, unknown>): string {
  const message = getVapiMessage(payload);
  const raw = message.type ?? payload.type ?? payload.event ?? "";
  return String(raw || "").trim().toLowerCase() || "unknown";
}

function isTerminalEvent(payload: Record<string, unknown>): boolean {
  const message = getVapiMessage(payload);
  const type = String(message.type ?? payload.type ?? payload.event ?? "").toLowerCase();
  if (type.includes("ended") || type.includes("end-of-call") || type.includes("end-of-call-report")) {
    return true;
  }

  const call = asObject(message.call) || asObject(payload.call);
  if (call) {
    const status = String(call.status ?? "").toLowerCase();
    if (status === "ended" || status === "completed") return true;
  }

  const blob = JSON.stringify(message).toLowerCase();
  return blob.includes("end-of-call-report");
}

function extractTranscript(payload: Record<string, unknown>): string | undefined {
  const message = getVapiMessage(payload);

  const direct =
    safeString(message.transcript) ||
    safeString(message.transcriptText) ||
    safeString((asObject(message.artifact) || {}).transcript) ||
    safeString((asObject(message.analysis) || {}).summary) ||
    safeString(payload.transcript);

  if (direct) return direct.slice(0, 8000);

  const messages = (asObject(message.artifact) || {}).messages;
  if (Array.isArray(messages)) {
    const joined = messages
      .map((item) => asObject(item))
      .map((item) => {
        if (!item) return undefined;
        return safeString(item.transcript) || safeString(item.content) || safeString(item.message);
      })
      .filter((v): v is string => Boolean(v))
      .join("\n");

    if (joined) return joined.slice(0, 8000);
  }

  return undefined;
}

function pickPathString(root: Record<string, unknown>, pathKeys: string[]): string | undefined {
  let current: unknown = root;
  for (const key of pathKeys) {
    const next = asObject(current);
    if (!next) return undefined;
    current = next[key];
  }
  return safeString(current);
}

function asHttpUrl(value: unknown): string | undefined {
  const raw = safeString(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extractRecordingUrl(payload: Record<string, unknown>): string | undefined {
  const message = getVapiMessage(payload);
  const candidates = [
    pickPathString(message, ["recordingUrl"]),
    pickPathString(message, ["stereoRecordingUrl"]),
    pickPathString(message, ["artifact", "recordingUrl"]),
    pickPathString(message, ["artifact", "stereoRecordingUrl"]),
    pickPathString(message, ["analysis", "recordingUrl"]),
    pickPathString(message, ["call", "recordingUrl"]),
    pickPathString(message, ["call", "artifact", "recordingUrl"]),
    pickPathString(payload, ["recordingUrl"]),
    pickPathString(payload, ["stereoRecordingUrl"]),
    pickPathString(payload, ["call", "recordingUrl"]),
    pickPathString(payload, ["call", "artifact", "recordingUrl"])
  ];

  for (const candidate of candidates) {
    const url = asHttpUrl(candidate);
    if (url) return url;
  }
  return undefined;
}

type AudioFormat = "mp3" | "wav";

interface AudioUrlSet {
  any: string[];
  mp3: string[];
  wav: string[];
}

interface VapiArtifactSnapshot {
  transcript?: string;
  audio: AudioUrlSet;
  startedAt?: string;
  endedAt?: string;
  status?: string;
}

function createAudioUrlSet(): AudioUrlSet {
  return { any: [], mp3: [], wav: [] };
}

function inferAudioFormatFromUrl(url: string): AudioFormat | undefined {
  const lowered = url.toLowerCase();
  if (lowered.includes(".mp3")) return "mp3";
  if (lowered.includes(".wav")) return "wav";
  return undefined;
}

function addAudioCandidate(set: AudioUrlSet, candidate: unknown, preferredFormat?: AudioFormat): void {
  const url = asHttpUrl(candidate);
  if (!url) return;
  if (!set.any.includes(url)) {
    set.any.push(url);
  }

  const inferred = inferAudioFormatFromUrl(url) || preferredFormat;
  if (inferred === "mp3" && !set.mp3.includes(url)) {
    set.mp3.push(url);
  }
  if (inferred === "wav" && !set.wav.includes(url)) {
    set.wav.push(url);
  }
}

function collectAudioCandidates(payload: Record<string, unknown>): AudioUrlSet {
  const set = createAudioUrlSet();
  const paths: Array<{ path: string[]; preferredFormat?: AudioFormat }> = [
    { path: ["recordingUrl"] },
    { path: ["stereoRecordingUrl"], preferredFormat: "wav" },
    { path: ["artifact", "recordingUrl"] },
    { path: ["artifact", "stereoRecordingUrl"], preferredFormat: "wav" },
    { path: ["analysis", "recordingUrl"] },
    { path: ["call", "recordingUrl"] },
    { path: ["call", "stereoRecordingUrl"], preferredFormat: "wav" },
    { path: ["call", "artifact", "recordingUrl"] },
    { path: ["call", "artifact", "stereoRecordingUrl"], preferredFormat: "wav" }
  ];

  for (const row of paths) {
    addAudioCandidate(set, pickPathString(payload, row.path), row.preferredFormat);
  }

  return set;
}

function mergeAudioSets(base: AudioUrlSet, incoming: AudioUrlSet): AudioUrlSet {
  const merged = createAudioUrlSet();
  for (const list of [base.any, incoming.any]) {
    for (const url of list) {
      addAudioCandidate(merged, url);
    }
  }
  for (const list of [base.mp3, incoming.mp3]) {
    for (const url of list) {
      addAudioCandidate(merged, url, "mp3");
    }
  }
  for (const list of [base.wav, incoming.wav]) {
    for (const url of list) {
      addAudioCandidate(merged, url, "wav");
    }
  }
  return merged;
}

function extractTranscriptFromVapiCall(payload: Record<string, unknown>): string | undefined {
  const callNode = asObject(payload.call) || payload;
  const artifact = asObject(callNode.artifact) || asObject(payload.artifact) || {};
  const analysis = asObject(callNode.analysis) || asObject(payload.analysis) || {};
  const summaryObj = asObject(analysis.summary) || {};

  const direct =
    safeString(callNode.transcript) ||
    safeString(payload.transcript) ||
    safeString(artifact.transcript) ||
    safeString(callNode.transcriptText) ||
    safeString(analysis.summary) ||
    safeString(summaryObj.transcript) ||
    safeString(summaryObj.summary);
  if (direct) return direct.slice(0, 8000);

  const messageLists: unknown[] = [
    artifact.messages,
    (asObject(callNode.artifact) || {}).messages,
    callNode.messages,
    payload.messages
  ];

  for (const list of messageLists) {
    if (!Array.isArray(list)) continue;
    const joined = list
      .map((row) => asObject(row))
      .map((row) => {
        if (!row) return undefined;
        const role = safeString(row.role)?.toLowerCase();
        const text = safeString(row.transcript) || safeString(row.content) || safeString(row.message);
        if (!text) return undefined;

        // Ignore prompt/system/tool payloads so transcript exports represent conversation only.
        if (role === "system" || role === "tool") return undefined;
        if (
          text.length > 1000 &&
          text.includes("Operating rules:") &&
          text.includes("Objective:") &&
          text.includes("Compliance notes:")
        ) {
          return undefined;
        }
        return text;
      })
      .filter((value): value is string => Boolean(value))
      .join("\n");
    if (joined) return joined.slice(0, 8000);
  }

  return undefined;
}

function extractVapiArtifacts(payload: Record<string, unknown>): VapiArtifactSnapshot {
  const callNode = asObject(payload.call) || payload;
  return {
    transcript: extractTranscriptFromVapiCall(payload),
    audio: collectAudioCandidates(payload),
    startedAt: safeString(callNode.startedAt) || safeString(payload.startedAt),
    endedAt: safeString(callNode.endedAt) || safeString(payload.endedAt),
    status: safeString(callNode.status) || safeString(payload.status)
  };
}

function deriveAudioFormatCandidates(url: string, format: AudioFormat): string[] {
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const normalized = asHttpUrl(value);
    if (!normalized) return;
    if (!out.includes(normalized)) out.push(normalized);
  };

  push(url);
  try {
    const parsed = new URL(url);
    const currentExt = path.extname(parsed.pathname).toLowerCase();
    const nextExt = `.${format}`;
    if (currentExt && currentExt !== nextExt) {
      parsed.pathname = parsed.pathname.slice(0, -currentExt.length) + nextExt;
      push(parsed.toString());
    }

    const queryVariants = ["format", "audioFormat", "fileFormat"];
    for (const key of queryVariants) {
      const copy = new URL(url);
      copy.searchParams.set(key, format);
      push(copy.toString());
    }
  } catch {
    // Keep original URL only when parsing fails.
  }

  return out;
}

async function isReachableAudioUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal
    });
    if (head.ok) return true;
    if (head.status === 405 || head.status === 403) {
      const get = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
        signal: controller.signal
      });
      return get.ok || get.status === 206;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function pickFirstReachableAudioUrl(candidates: string[]): Promise<string | undefined> {
  const deduped = Array.from(new Set(candidates.map((value) => asHttpUrl(value)).filter((v): v is string => Boolean(v))));
  for (const candidate of deduped) {
    if (await isReachableAudioUrl(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function chooseAudioUrlFromSet(audio: AudioUrlSet, format?: AudioFormat): Promise<string | undefined> {
  const preferred = format === "mp3" ? audio.mp3 : format === "wav" ? audio.wav : audio.any;
  return format ? preferred[0] : preferred[0] || audio.any[0];
}

async function fetchVapiArtifactsByCallId(callId: string): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  artifacts?: VapiArtifactSnapshot;
  raw?: Record<string, unknown>;
}> {
  const normalizedCallId = safeString(callId);
  if (!normalizedCallId) {
    return {
      ok: false,
      statusCode: 400,
      error: "callId is required"
    };
  }

  const remote = await fetchVapiCallById(normalizedCallId);
  if (!remote.ok || !remote.data) {
    return {
      ok: false,
      statusCode: remote.status >= 400 && remote.status < 600 ? remote.status : 502,
      error: remote.error || "Failed to fetch call from Vapi"
    };
  }

  return {
    ok: true,
    statusCode: remote.status,
    artifacts: extractVapiArtifacts(remote.data),
    raw: remote.data
  };
}

async function refreshLeadArtifactsFromVapi(
  lead: Lead
): Promise<{
  lead: Lead;
  fetched: boolean;
  updated: boolean;
  statusCode: number;
  error?: string;
  artifacts: VapiArtifactSnapshot;
}> {
  const localArtifacts: VapiArtifactSnapshot = {
    transcript: safeString(lead.transcript),
    audio: createAudioUrlSet(),
    startedAt: lead.callAttemptedAt,
    endedAt: lead.callEndedAt
  };
  addAudioCandidate(localArtifacts.audio, lead.recordingUrl);

  if (!lead.callId) {
    return {
      lead,
      fetched: false,
      updated: false,
      statusCode: 0,
      error: "Lead does not have a callId yet",
      artifacts: localArtifacts
    };
  }

  const remote = await fetchVapiCallById(lead.callId);
  if (!remote.ok || !remote.data) {
    return {
      lead,
      fetched: false,
      updated: false,
      statusCode: remote.status,
      error: remote.error || "Failed to fetch call from Vapi",
      artifacts: localArtifacts
    };
  }

  const fetchedArtifacts = extractVapiArtifacts(remote.data);
  const mergedAudio = mergeAudioSets(localArtifacts.audio, fetchedArtifacts.audio);
  const mergedTranscript = fetchedArtifacts.transcript || localArtifacts.transcript;
  const primaryAudio = mergedAudio.any[0];
  const patch: Partial<Lead> = {};

  if (mergedTranscript && (!lead.transcript || mergedTranscript.length >= lead.transcript.length)) {
    patch.transcript = mergedTranscript;
    patch.transcriptSummary = mergedTranscript.slice(0, 300);
  }

  if (primaryAudio && primaryAudio !== lead.recordingUrl) {
    patch.recordingUrl = primaryAudio;
  }

  if (fetchedArtifacts.endedAt && !lead.callEndedAt) {
    patch.callEndedAt = fetchedArtifacts.endedAt;
  }

  if (fetchedArtifacts.status) {
    const normalized = fetchedArtifacts.status.toLowerCase();
    if (lead.status === "dialing" && ["ended", "completed", "failed", "cancelled", "canceled"].includes(normalized)) {
      patch.status = lead.outcome === "booked" ? "booked" : "completed";
    }
  }

  const updatedLead =
    Object.keys(patch).length > 0
      ? (await patchLead(lead.id, patch)) || { ...lead, ...patch, updatedAt: nowIso() }
      : { ...lead };

  return {
    lead: updatedLead,
    fetched: true,
    updated: Object.keys(patch).length > 0,
    statusCode: remote.status,
    artifacts: {
      ...fetchedArtifacts,
      transcript: updatedLead.transcript || mergedTranscript,
      audio: mergedAudio
    }
  };
}

async function resolveAudioDownloadUrl(
  lead: Lead,
  format?: AudioFormat,
  refresh = false
): Promise<{
  lead: Lead;
  url?: string;
  refreshed: boolean;
  error?: string;
  statusCode?: number;
  audio: AudioUrlSet;
}> {
  let workingLead = lead;
  const local = createAudioUrlSet();
  addAudioCandidate(local, lead.recordingUrl);
  let audio = local;
  let refreshError: string | undefined;
  let refreshStatusCode: number | undefined;
  let refreshed = false;

  const hasFormat =
    format === "mp3" ? audio.mp3.length > 0 : format === "wav" ? audio.wav.length > 0 : audio.any.length > 0;
  const shouldRefresh = refresh || !hasFormat;

  if (shouldRefresh && lead.callId) {
    const pulled = await refreshLeadArtifactsFromVapi(lead);
    workingLead = pulled.lead;
    audio = mergeAudioSets(audio, pulled.artifacts.audio);
    refreshed = pulled.fetched;
    refreshError = pulled.error;
    refreshStatusCode = pulled.statusCode;
  }

  let url: string | undefined = await chooseAudioUrlFromSet(audio, format);

  return {
    lead: workingLead,
    url,
    refreshed,
    error: refreshError,
    statusCode: refreshStatusCode,
    audio
  };
}

async function findLeadByIdentity(input: { leadId?: string; phone?: string; email?: string }): Promise<Lead | undefined> {
  return withState((state) => {
    if (input.leadId && state.leads[input.leadId]) {
      return { ...state.leads[input.leadId] };
    }

    const email = input.email?.trim().toLowerCase();
    const phone = input.phone ? normalizePhone(input.phone) : undefined;

    const matched = Object.values(state.leads).find((lead) => {
      const emailMatch = email && lead.email && lead.email.toLowerCase() === email;
      const phoneMatch = phone && normalizePhone(lead.phone) === phone;
      return Boolean(emailMatch || phoneMatch);
    });

    return matched ? { ...matched } : undefined;
  });
}

async function createFallbackLeadForGhlSync(input: {
  phone?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  company?: string;
  campaign?: string;
  notes?: string;
  outcome?: string;
  transcript?: string;
  bookingSource?: string;
  callId?: string;
}): Promise<Lead | undefined> {
  const normalizedPhone = normalizePhone(input.phone);
  if (!normalizedPhone) return undefined;

  const normalizedEmail = safeString(input.email)?.toLowerCase();
  const fullName = safeString(input.fullName);
  const nameParts = splitFullName(fullName);
  const firstName = safeString(input.firstName) || nameParts.firstName;
  const lastName = safeString(input.lastName) || nameParts.lastName;
  const company = safeString(input.company);
  const campaign = safeString(input.campaign) || config.campaignName;
  const outcome = safeString(input.outcome) || "ghl_sync_imported";
  const transcript = safeString(input.transcript);
  const bookingSource = safeString(input.bookingSource) || "ghl-fallback";
  const callId = safeString(input.callId);
  const notes = safeString(input.notes);

  const stableId = `ghl-fallback-${hashShort(`${normalizedPhone}|${normalizedEmail || ""}`)}`;
  const now = nowIso();

  return withState((state) => {
    const existingById = state.leads[stableId];
    const existingByIdentity = Object.values(state.leads).find((lead) => {
      const phoneMatch = normalizePhone(lead.phone) === normalizedPhone;
      const emailMatch =
        Boolean(normalizedEmail) && Boolean(lead.email) && lead.email!.trim().toLowerCase() === normalizedEmail;
      return phoneMatch || emailMatch;
    });

    const existing = existingById || existingByIdentity;
    if (existing) {
      existing.firstName = firstName || existing.firstName;
      existing.lastName = lastName || existing.lastName;
      existing.company = company || existing.company;
      existing.email = normalizedEmail || existing.email;
      existing.campaign = campaign || existing.campaign;
      existing.notes = notes || existing.notes;
      existing.outcome = existing.outcome || outcome;
      existing.transcript = existing.transcript || transcript;
      existing.bookingSource = existing.bookingSource || bookingSource;
      existing.callId = existing.callId || callId;
      existing.callAttemptedAt = existing.callAttemptedAt || now;
      existing.lastAttemptAt = existing.lastAttemptAt || now;
      existing.attempts = Math.max(1, existing.attempts || 0);
      existing.updatedAt = now;
      return { ...existing };
    }

    const fallback: Lead = {
      id: stableId,
      phone: normalizedPhone,
      firstName,
      lastName,
      company,
      email: normalizedEmail,
      timezone: config.defaultTimezone,
      campaign,
      sourceFile: "ghl-sync-fallback",
      sourceRow: 0,
      findings: "Auto-created for GHL sync fallback",
      notes: notes || "Created because sync_ghl_contact was called without a matching local lead.",
      optIn: true,
      dnc: false,
      status: "completed",
      attempts: 1,
      nextAttemptAt: undefined,
      lastAttemptAt: now,
      callId,
      callAttemptedAt: now,
      outcome,
      transcript,
      bookingSource,
      createdAt: now,
      updatedAt: now
    };

    state.leads[fallback.id] = fallback;
    return { ...fallback };
  });
}

async function findLeadById(leadId: string): Promise<Lead | undefined> {
  const id = safeString(leadId);
  if (!id) return undefined;
  return withState((state) => {
    const lead = state.leads[id];
    return lead ? { ...lead } : undefined;
  });
}

async function findLeadByIdOrCallId(value: string): Promise<Lead | undefined> {
  const key = safeString(value);
  if (!key) return undefined;
  return withState((state) => {
    const direct = state.leads[key];
    if (direct) return { ...direct };

    const matched = Object.values(state.leads).find((lead) => safeString(lead.callId) === key);
    return matched ? { ...matched } : undefined;
  });
}

function isTerminalVapiCall(payload: Record<string, unknown>): boolean {
  const statusRaw =
    safeString(payload.status) ||
    safeString((asObject(payload.call) || {}).status) ||
    safeString((asObject(getVapiMessage(payload).call) || {}).status) ||
    "";
  const status = statusRaw.trim().toLowerCase();
  if (status === "ended" || status === "completed" || status === "failed" || status === "canceled" || status === "cancelled") {
    return true;
  }

  if (safeString(payload.endedAt)) return true;
  const callObj = asObject(payload.call) || asObject(getVapiMessage(payload).call);
  if (callObj && safeString(callObj.endedAt)) return true;
  return false;
}

async function fetchVapiCallById(callId: string): Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }> {
  if (!config.vapiApiKey) {
    return { ok: false, status: 0, error: "Missing VAPI_API_KEY" };
  }

  const response = await fetch(`${config.vapiBaseUrl}/call/${encodeURIComponent(callId)}`, {
    headers: {
      Authorization: `Bearer ${config.vapiApiKey}`,
      Accept: "application/json"
    }
  });
  const raw = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, error: raw.slice(0, 300) };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { ok: true, status: response.status, data: parsed };
  } catch {
    return { ok: false, status: response.status, error: "Invalid JSON response from Vapi call API" };
  }
}

async function patchLead(leadId: string, patch: Partial<Lead>): Promise<Lead | undefined> {
  return withState((state) => {
    const lead = state.leads[leadId];
    if (!lead) return undefined;

    Object.assign(lead, patch);
    lead.updatedAt = nowIso();
    return { ...lead };
  });
}

async function reconcileDialingCalls(input?: {
  minAgeSeconds?: number;
  limit?: number;
  source?: string;
}): Promise<{
  scanned: number;
  finalized: number;
  stillActive: number;
  notFound: number;
  failedPatched: number;
  errors: number;
  minAgeSeconds: number;
  limit: number;
  source: string;
}> {
  const minAgeSeconds = Math.max(30, Math.trunc(input?.minAgeSeconds || config.reconcileMinAgeSeconds));
  const limit = Math.max(1, Math.min(1000, Math.trunc(input?.limit || 200)));
  const source = input?.source || "manual";
  const cutoffTs = Date.now() - minAgeSeconds * 1000;

  const targets = await withState((state) => {
    return Object.values(state.leads)
      .filter((lead) => lead.status === "dialing" && Boolean(lead.callId))
      .filter((lead) => {
        const ts = Date.parse(lead.callAttemptedAt || lead.lastAttemptAt || lead.updatedAt || "");
        if (!Number.isFinite(ts)) return true;
        return ts <= cutoffTs;
      })
      .sort((a, b) => {
        const aTs = Date.parse(a.callAttemptedAt || a.lastAttemptAt || a.updatedAt || "");
        const bTs = Date.parse(b.callAttemptedAt || b.lastAttemptAt || b.updatedAt || "");
        return (Number.isFinite(aTs) ? aTs : 0) - (Number.isFinite(bTs) ? bTs : 0);
      })
      .slice(0, limit)
      .map((lead) => ({
        leadId: lead.id,
        callId: String(lead.callId),
        attempts: lead.attempts || 0
      }));
  });

  let scanned = 0;
  let finalized = 0;
  let stillActive = 0;
  let notFound = 0;
  let failedPatched = 0;
  let errors = 0;

  for (const target of targets) {
    scanned += 1;
    try {
      const remote = await fetchVapiCallById(target.callId);
      if (!remote.ok) {
        if (remote.status === 404) {
          notFound += 1;
          if (target.attempts >= config.maxAttempts) {
            const patched = await patchLead(target.leadId, {
              status: "failed",
              callEndedAt: nowIso(),
              nextAttemptAt: undefined,
              lastError: "Reconcile: Vapi call not found."
            });
            if (patched) failedPatched += 1;
          }
          continue;
        }
        errors += 1;
        continue;
      }

      const payload = remote.data || {};
      if (!isTerminalVapiCall(payload)) {
        stillActive += 1;
        continue;
      }

      await finalizeCall(target.callId, payload);
      finalized += 1;
    } catch (error) {
      errors += 1;
      runtimeError("worker", "reconcile call lookup failed", error, {
        callId: target.callId,
        leadId: target.leadId
      });
    }
  }

  const summary = {
    scanned,
    finalized,
    stillActive,
    notFound,
    failedPatched,
    errors,
    minAgeSeconds,
    limit,
    source
  };
  if (scanned > 0 || finalized > 0 || errors > 0) {
    runtimeInfo("worker", "reconcile pass completed", summary);
  }
  return summary;
}

function normalizeOutcome(outcome?: string): string {
  if (!outcome) return "";
  const base = outcome.split(";")[0] || "";
  return base.trim().toLowerCase().replace(/\s+/g, "_");
}

function isWinOutcome(outcome?: string): boolean {
  const normalized = normalizeOutcome(outcome);
  return normalized === "booked" || normalized === "callback_requested";
}

function isVoicemailOutcome(outcome?: string): boolean {
  return normalizeOutcome(outcome) === "voicemail";
}

function extractSmsSidFromNotes(notes?: string): string | undefined {
  const text = safeString(notes);
  if (!text) return undefined;
  const match = text.match(/bookingConfirmationSmsSid=([A-Za-z0-9]+)/);
  return match?.[1];
}

async function maybeSendWinSms(lead: Lead, outcome?: string): Promise<void> {
  const latest = await withState((state) => {
    const current = state.leads[lead.id];
    return current ? { ...current } : undefined;
  });
  if (!latest) return;

  if (!isWinOutcome(outcome || latest.outcome)) return;
  if (latest.dnc) return;
  const isProspectorLead = latest.sourceFile === "prospector-dashboard";
  if (!latest.optIn && !isProspectorLead) return;
  if (!isTwilioSmsConfigured() || !resolvedBookingUrl()) return;
  if (!isProspectorLead && !canSendWinSms()) return;
  if (latest.winSmsSentAt) return;

  try {
    const sent =
      isProspectorLead && latest.deployedSiteUrl
        ? await sendProspectorFollowUpSms({
            to: latest.phone,
            firstName: latest.firstName,
            campaign: latest.campaign,
            liveLink: latest.deployedSiteUrl
          })
        : await sendWinBookingSms({
            to: latest.phone,
            firstName: latest.firstName,
            campaign: latest.campaign
          });

    await patchLead(latest.id, {
      winSmsSentAt: nowIso(),
      winSmsError: undefined,
      smsLastSid: sent.sid,
      smsLastSentAt: nowIso(),
      smsLastType: isProspectorLead ? "prospector-win-followup" : "win-followup",
      smsLastError: undefined
    });
  } catch (error) {
    await patchLead(latest.id, {
      winSmsError: String(error).slice(0, 500),
      smsLastType: isProspectorLead ? "prospector-win-followup" : "win-followup",
      smsLastError: String(error).slice(0, 500)
    });
    console.error("[SMS] Win SMS send failed", error);
  }
}

async function maybeSendVoicemailFollowUpSms(lead: Lead, outcome?: string): Promise<void> {
  const latest = await withState((state) => {
    const current = state.leads[lead.id];
    return current ? { ...current } : undefined;
  });
  if (!latest) return;

  if (!isVoicemailOutcome(outcome || latest.outcome)) return;
  if (!latest.optIn || latest.dnc) return;
  if (!isTwilioSmsConfigured()) return;
  if (!resolvedBookingUrl()) return;
  if (latest.voicemailSmsSentAt) return;

  const greeting = latest.firstName ? `Hi ${latest.firstName},` : "Hi,";
  const body = `${greeting} this is Jarvis with True Rank Digital. I just tried reaching you. Book your AI visibility call here: ${resolvedBookingUrl()}. A team member may reach out before the call.`;

  try {
    const sent = await sendSmsMessage({
      to: latest.phone,
      body
    });

    await patchLead(latest.id, {
      voicemailSmsSentAt: nowIso(),
      voicemailSmsError: undefined,
      smsLastSid: sent.sid,
      smsLastSentAt: nowIso(),
      smsLastType: "voicemail-followup",
      smsLastError: undefined
    });
  } catch (error) {
    await patchLead(latest.id, {
      voicemailSmsError: String(error).slice(0, 500),
      smsLastType: "voicemail-followup",
      smsLastError: String(error).slice(0, 500)
    });
    console.error("[SMS] Voicemail follow-up SMS send failed", error);
  }
}

async function syncLeadAfterAttempt(
  lead: Lead,
  details: { outcome?: string; transcript?: string; bookingSource?: string; force?: boolean }
): Promise<void> {
  const result = await syncLeadToGhl({
    lead,
    outcome: details.outcome,
    transcript: details.transcript,
    bookingSource: details.bookingSource,
    force: details.force
  });

  await patchLead(lead.id, {
    ghlContactId: result.contactId,
    ghlSyncedAt: result.synced ? nowIso() : lead.ghlSyncedAt,
    ghlLastError: result.synced ? undefined : result.error
  });
}

async function finalizeCall(callId: string, payload: Record<string, unknown>): Promise<void> {
  const outcome = inferOutcome(payload);
  const retargetBucket = retargetBucketFromOutcome(outcome);
  const suspicious = hasPromptInjectionSignals(payload);
  const transcript = extractTranscript(payload);
  const recordingUrl = extractRecordingUrl(payload);
  const endedAt =
    safeString(payload.endedAt) ||
    safeString((asObject(payload.call) || {}).endedAt) ||
    safeString((asObject(getVapiMessage(payload).call) || {}).endedAt) ||
    nowIso();
  const noContact = noContactFromOutcome(outcome);

  const lead = await withState((state) => {
    const found = Object.values(state.leads).find((entry) => entry.callId === callId);
    if (!found) return undefined;

    found.outcome = suspicious ? `${outcome};prompt_injection_flag` : outcome;
    found.transcript = noContact ? undefined : transcript;
    found.transcriptSummary = noContact
      ? undefined
      : transcript
      ? transcript.slice(0, 300)
      : found.transcriptSummary;
    found.recordingUrl = recordingUrl || found.recordingUrl;
    found.retargetBucket = retargetBucket;
    found.retargetReason = retargetBucket ? outcome : undefined;
    found.retargetReadyAt = retargetBucket ? nowIso() : undefined;
    found.callEndedAt = endedAt;
    found.status = outcome === "booked" ? "booked" : "completed";
    found.updatedAt = nowIso();

    return { ...found };
  });

  if (!lead) return;
  runtimeInfo("webhook", "call finalized", {
    callId,
    leadId: lead.id,
    outcome: lead.outcome || outcome,
    retargetBucket: lead.retargetBucket || "",
    hasRecording: Boolean(lead.recordingUrl)
  });
  setDialerPostCallCooldown(config.postCallDelaySeconds * 1000);
  await syncLeadAfterAttempt(lead, { outcome: lead.outcome, transcript: lead.transcript });
  await maybeSendVoicemailFollowUpSms(lead, outcome);
  await maybeSendWinSms(lead, outcome);

  if (config.retargetAutoExport && retargetBucketFromOutcome(lead.outcome)) {
    try {
      const leads = await withState((state) => Object.values(state.leads).map((entry) => ({ ...entry })));
      await exportRetargetBuckets(leads, { writeLatest: true, writeSnapshot: false });
    } catch (error) {
      console.error("[RETARGET] auto-export failed", error);
    }
  }
}

function startReconcileLoop(): void {
  if (reconcileLoopStarted) return;
  reconcileLoopStarted = true;
  runtimeInfo("dialer", "reconcile loop started", {
    intervalSeconds: config.reconcileIntervalSeconds,
    minAgeSeconds: config.reconcileMinAgeSeconds
  });

  const intervalMs = Math.max(15_000, config.reconcileIntervalSeconds * 1000);
  setInterval(() => {
    reconcileDialingCalls({
      minAgeSeconds: config.reconcileMinAgeSeconds,
      limit: 200,
      source: "auto-loop"
    }).catch((error) => {
      runtimeError("worker", "reconcile loop error", error);
    });
  }, intervalMs);
}

function verifySecret(req: Request): boolean {
  if (!config.webhookSecret) return true;
  const header = req.header("x-vapi-secret") || req.header("authorization") || "";
  return header.includes(config.webhookSecret);
}

function parseSignatureHeader(header: string): { t?: string; v1?: string } {
  const parts = header.split(",").map((piece) => piece.trim());
  const parsed: { t?: string; v1?: string } = {};
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    if (k === "t") parsed.t = v;
    if (k === "v1") parsed.v1 = v;
  }
  return parsed;
}

function verifyCalendlyWebhook(req: RawBodyRequest): boolean {
  if (!config.calendlyWebhookSigningKey) return true;
  const header = req.header("calendly-webhook-signature") || "";
  const parsed = parseSignatureHeader(header);
  if (!parsed.t || !parsed.v1) return false;

  const raw = req.rawBody || "";
  const signed = `${parsed.t}.${raw}`;
  const expected = crypto.createHmac("sha256", config.calendlyWebhookSigningKey).update(signed).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(parsed.v1, "hex");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

function verifyGoogleCalendarWebhook(req: Request): boolean {
  if (!config.googleCalendarWebhookSecret) return true;
  const header = req.header("x-google-calendar-secret") || req.header("authorization") || "";
  return header.includes(config.googleCalendarWebhookSecret);
}

function extractPhoneFromCalendlyPayload(payload: Record<string, unknown>): string | undefined {
  const invitee = asObject(payload.invitee);
  const direct =
    safeString(payload.phone_number) ||
    safeString(payload.phone) ||
    safeString(invitee?.phone_number) ||
    safeString(invitee?.phone);
  if (direct) return direct;

  const qa = payload.questions_and_answers;
  if (!Array.isArray(qa)) return undefined;

  for (const item of qa) {
    const obj = asObject(item);
    if (!obj) continue;
    const answer = safeString(obj.answer);
    const question = safeString(obj.question)?.toLowerCase() || "";
    if (answer && question.includes("phone")) return answer;
  }
  return undefined;
}

async function getTemplateById(id: string): Promise<AgentTemplate | undefined> {
  const state = await loadTemplateState();
  return state.templates[id];
}

async function getActiveTemplate(): Promise<AgentTemplate | undefined> {
  const state = await loadTemplateState();
  if (!state.activeTemplateId) return undefined;
  return state.templates[state.activeTemplateId];
}

function voiceFromTemplate(template?: AgentTemplate): VoiceProfile {
  if (!template) return "female";
  if (template.voiceProfile === "male") return "male";
  return "female";
}

function leadFromTestPayload(body: Record<string, unknown>, normalizedPhone: string, template?: AgentTemplate): Lead {
  const now = nowIso();
  const firstName = safeString(body.firstName);
  const lastName = safeString(body.lastName);
  const company = safeString(body.company);
  const findings = safeString(body.findings) || template?.offerSummary;
  const profileRaw = safeString(body.voiceProfile)?.toLowerCase() || "";
  const profile = profileRaw === "male" || profileRaw === "female" ? profileRaw : "female";

  return {
    id: `manual-${hashShort(`${normalizedPhone}-${Date.now()}`)}`,
    phone: normalizedPhone,
    firstName,
    lastName,
    company,
    email: undefined,
    timezone: config.defaultTimezone,
    campaign: template ? `${template.name} (${profile})` : `Manual Test (${profile})`,
    sourceFile: "dashboard",
    sourceRow: 0,
    findings,
    notes: template ? `Template test call: ${template.name}` : "Manual dashboard test call",
    optIn: true,
    dnc: false,
    status: "queued",
    attempts: 1,
    callAttemptedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

async function upsertManualLead(lead: Lead): Promise<Lead> {
  return withState((state) => {
    state.leads[lead.id] = {
      ...lead,
      updatedAt: nowIso()
    };
    return { ...state.leads[lead.id] };
  });
}

async function markManualLeadCallCreated(leadId: string, callId: string): Promise<Lead | undefined> {
  return withState((state) => {
    const lead = state.leads[leadId];
    if (!lead) return undefined;
    lead.callId = callId;
    lead.status = "dialing";
    lead.outcome = "call_started";
    lead.callAttemptedAt = nowIso();
    lead.lastAttemptAt = nowIso();
    lead.attempts = Math.max(1, lead.attempts || 0);
    lead.lastError = undefined;
    lead.nextAttemptAt = undefined;
    lead.updatedAt = nowIso();
    return { ...lead };
  });
}

async function markLeadBooked(lead: Lead, source: string): Promise<Lead | undefined> {
  return patchLead(lead.id, {
    status: "booked",
    outcome: "booked",
    bookedAt: nowIso(),
    bookingSource: source,
    retargetBucket: undefined,
    retargetReason: undefined,
    retargetReadyAt: undefined
  });
}

const SCHEDULING_TOOL_NAMES = [
  "get_event_types",
  "get_available_times",
  "create_booking",
  "send_booking_sms",
  "sync_ghl_contact"
] as const;

function supportedSchedulingToolNames(): string[] {
  return [...SCHEDULING_TOOL_NAMES];
}

function buildSchedulingToolPayloads(input: {
  serverUrl: string;
  strict: boolean;
  includeGhlSyncTool: boolean;
}): Array<Record<string, unknown>> {
  const makeFunction = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    asyncMode: boolean
  ): Record<string, unknown> => ({
    type: "function",
    async: asyncMode,
    function: {
      name,
      description,
      strict: input.strict,
      parameters
    },
    server: {
      url: input.serverUrl
    }
  });

  const tools: Array<Record<string, unknown>> = [
    makeFunction(
      "get_event_types",
      "List Calendly event types that can be booked.",
      {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      },
      false
    ),
    makeFunction(
      "get_available_times",
      "Get available times for a Calendly event type within a 7 day window.",
      {
        type: "object",
        properties: {
          eventTypeUri: { type: "string", description: "Calendly event type URI (or UUID)." },
          startTime: { type: "string", description: "Window start in ISO-8601 UTC." },
          endTime: { type: "string", description: "Window end in ISO-8601 UTC." },
          timezone: { type: "string", description: "IANA timezone (example: America/New_York)." }
        },
        required: ["eventTypeUri", "startTime", "endTime", "timezone"],
        additionalProperties: false
      },
      false
    ),
    makeFunction(
      "create_booking",
      "Book a meeting in Calendly after the caller confirms a specific day/time.",
      {
        type: "object",
        properties: {
          eventTypeUri: { type: "string", description: "Calendly event type URI (or UUID)." },
          startTime: { type: "string", description: "Selected slot in ISO-8601 UTC." },
          name: { type: "string", description: "Invitee full name." },
          email: { type: "string", description: "Invitee email address." },
          timezone: { type: "string", description: "Invitee timezone (IANA format)." }
        },
        required: ["eventTypeUri", "startTime", "name", "email", "timezone"],
        additionalProperties: false
      },
      false
    ),
    makeFunction(
      "send_booking_sms",
      "Send booking SMS follow-up. For prospector flows include the live vision link plus booking link.",
      {
        type: "object",
        properties: {
          phone: { type: "string", description: "Destination phone in E.164 format. If omitted, call customer number is used." },
          firstName: { type: "string", description: "Prospect first name for personalization." },
          liveLink: { type: "string", description: "Optional live vision/deploy URL to include in SMS." },
          bookingUrl: { type: "string", description: "Optional booking URL override." },
          leadId: { type: "string", description: "Optional lead id for lookup/context." }
        },
        required: [],
        additionalProperties: false
      },
      false
    )
  ];

  if (input.includeGhlSyncTool) {
    tools.push(
      makeFunction(
        "sync_ghl_contact",
        "Background sync of the matched lead to GoHighLevel after call updates.",
        {
          type: "object",
          properties: {
            leadId: { type: "string", description: "Internal lead id from this dialer system." }
          },
          required: ["leadId"],
          additionalProperties: false
        },
        true
      )
    );
  }

  return tools;
}

async function executeSchedulingToolInvocation(
  tool: VapiToolInvocation,
  payload: Record<string, unknown>
): Promise<unknown> {
  const normalized = normalizeToolName(tool.name);
  const args = tool.args || {};

  if (normalized === "get_event_types" || normalized === "list_event_types" || normalized === "get_calendly_event_types") {
    const count = asOptionalInt(args.count ?? args.limit, 1, 100) || 20;
    const eventTypes = await listCalendlyEventTypes({
      organizationUri: safeString(args.organizationUri) || safeString(args.organization),
      userUri: safeString(args.userUri) || safeString(args.user),
      count,
      active: true
    });

    return {
      ok: true,
      count: eventTypes.length,
      eventTypes: eventTypes.map((row) => ({
        uri: row.uri,
        name: row.name,
        duration: row.duration,
        schedulingUrl: row.schedulingUrl,
        slug: row.slug
      }))
    };
  }

  if (
    normalized === "get_available_times" ||
    normalized === "list_available_times" ||
    normalized === "get_event_type_available_times"
  ) {
    const eventTypeRaw =
      safeString(args.eventTypeUri) ||
      safeString(args.event_type_uri) ||
      safeString(args.eventType) ||
      safeString(args.event_type);
    if (!eventTypeRaw) {
      throw new Error("eventTypeUri is required");
    }

    const startTime = parseIsoTimestamp(args.startTime ?? args.start_time);
    const endTimeRaw = parseIsoTimestamp(args.endTime ?? args.end_time);
    if (!startTime || !endTimeRaw) {
      throw new Error("startTime and endTime are required ISO timestamps");
    }

    const startMs = Date.parse(startTime);
    const endMs = Date.parse(endTimeRaw);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error("Invalid availability window");
    }

    const maxRangeMs = 7 * 24 * 60 * 60 * 1000;
    const normalizedEndTime = new Date(Math.min(endMs, startMs + maxRangeMs)).toISOString();

    const timezone = safeString(args.timezone) || config.defaultTimezone;
    const availableTimes = await listCalendlyEventTypeAvailableTimes({
      eventTypeUri: normalizeCalendlyEventTypeUri(eventTypeRaw),
      startTime,
      endTime: normalizedEndTime,
      timezone
    });

    return {
      ok: true,
      count: availableTimes.length,
      timezone,
      availableTimes: availableTimes.map((slot) => ({
        startTime: slot.startTime,
        status: slot.status,
        inviteesRemaining: slot.inviteesRemaining
      }))
    };
  }

  if (normalized === "send_booking_sms" || normalized === "text_booking_link") {
    const phone = safeString(args.phone) || extractPhoneFromToolPayload(payload);
    if (!phone) {
      throw new Error("No phone number available for SMS");
    }

    const lead = await findLeadByIdentity({
      leadId: safeString(args.leadId) || extractLeadIdFromToolPayload(payload),
      phone,
      email: safeString(args.email)
    });

    const firstName = safeString(args.firstName) || lead?.firstName || extractFirstNameFromToolPayload(payload);
    const greeting = firstName ? `Hi ${firstName},` : "Hi,";
    const liveLink = safeString(args.liveLink) || safeString(args.live_link) || lead?.deployedSiteUrl || "";
    const bookingUrl =
      safeString(args.bookingUrl) || safeString(args.booking_url) || lead?.bookingUrlOverride || resolvedBookingUrl();
    const smsBody =
      safeString(args.message) ||
      (liveLink
        ? `${greeting} Here is the live vision link: ${liveLink}. If you want to move forward, book here: ${bookingUrl}. A team member may reach out before the meeting.`
        : `${greeting} I just sent your booking link: ${bookingUrl}. A team member may reach out before the meeting.`);

    const sent = await sendSmsMessage({
      to: phone,
      body: smsBody
    });

    if (lead) {
      await patchLead(lead.id, {
        winSmsSentAt: nowIso(),
        winSmsError: undefined,
        smsLastSid: sent.sid,
        smsLastSentAt: nowIso(),
        smsLastType: "tool-send-booking",
        smsLastError: undefined
      });
    }

    return {
      ok: true,
      smsSent: true,
      sid: sent.sid,
      to: phone
    };
  }

  if (normalized === "create_booking" || normalized === "book_meeting" || normalized === "create_invitee") {
    const eventTypeRaw =
      safeString(args.eventTypeUri) ||
      safeString(args.event_type_uri) ||
      safeString(args.eventType) ||
      safeString(args.event_type);
    const startTime = parseIsoTimestamp(args.startTime ?? args.start_time);
    const email = safeString(args.email);
    const name = safeString(args.name) || safeString(args.fullName);
    const timezone = safeString(args.timezone) || config.defaultTimezone;
    const phoneHint = safeString(args.phone) || extractPhoneFromToolPayload(payload);
    const leadFromPayload = await findLeadByIdentity({
      leadId: safeString(args.leadId) || extractLeadIdFromToolPayload(payload),
      phone: phoneHint,
      email
    });

    if (!eventTypeRaw) throw new Error("eventTypeUri is required");
    if (!startTime) throw new Error("startTime is required");
    if (!name) throw new Error("name is required");

    if (!email) {
      const fallbackBookingUrl = leadFromPayload?.bookingUrlOverride || resolvedBookingUrl();
      if (phoneHint) {
        const sent = await sendSmsMessage({
          to: phoneHint,
          body: `No problem. Use this booking link: ${fallbackBookingUrl}. A team member may reach out before the meeting.`
        });

        if (leadFromPayload) {
          await patchLead(leadFromPayload.id, {
            winSmsSentAt: nowIso(),
            winSmsError: undefined,
            smsLastSid: sent.sid,
            smsLastSentAt: nowIso(),
            smsLastType: "booking-email-missing-fallback",
            smsLastError: undefined
          });
        }

        return {
          ok: false,
          booked: false,
          requiresEmail: true,
          fallback: "sms-booking-link",
          smsSent: true,
          sid: sent.sid,
          message: "Email is required for direct Calendly booking. Sent booking link by SMS."
        };
      }
      throw new Error("email is required");
    }

    let booking:
      | {
          uri?: string;
          status?: string;
          event?: string;
          cancelUrl?: string;
          rescheduleUrl?: string;
          timezone?: string;
          startTime?: string;
        }
      | undefined;
    try {
      const nameParts = splitFullName(name);
      booking = await createCalendlyInvitee({
        eventTypeUri: normalizeCalendlyEventTypeUri(eventTypeRaw),
        startTime,
        invitee: {
          name,
          email,
          timezone,
          firstName: nameParts.firstName,
          lastName: nameParts.lastName
        },
        notes: safeString(args.notes)
      });
    } catch (error) {
      const fallbackBookingUrl = leadFromPayload?.bookingUrlOverride || resolvedBookingUrl();
      if (phoneHint) {
        const sent = await sendSmsMessage({
          to: phoneHint,
          body: `We hit a scheduling issue right now. Use this booking link: ${fallbackBookingUrl}. A team member may reach out before the meeting.`
        });
        if (leadFromPayload) {
          await patchLead(leadFromPayload.id, {
            winSmsSentAt: nowIso(),
            winSmsError: undefined,
            smsLastSid: sent.sid,
            smsLastSentAt: nowIso(),
            smsLastType: "booking-create-failed-fallback",
            smsLastError: undefined
          });
        }

        return {
          ok: false,
          booked: false,
          fallback: "sms-booking-link",
          smsSent: true,
          sid: sent.sid,
          error: String(error).slice(0, 300),
          message: "Direct booking failed. Sent booking link by SMS."
        };
      }
      throw error;
    }

    const matchedLead = leadFromPayload;

    let leadId: string | undefined;
    if (matchedLead) {
      const updated = await markLeadBooked(matchedLead, "calendly-tool");
      if (updated) {
        leadId = updated.id;
        await syncLeadAfterAttempt(updated, {
          outcome: "booked",
          bookingSource: "calendly-tool",
          transcript: updated.transcript,
          force: true
        });
        if (asBool(args.sendSms, true) && (phoneHint || updated.phone)) {
          const confirmationUrl = updated.bookingUrlOverride || booking.rescheduleUrl || booking.cancelUrl || resolvedBookingUrl();
          const sent = await sendSmsMessage({
            to: phoneHint || updated.phone,
            body: `You're booked for the free AI Search strategy session. Confirmation: ${confirmationUrl}`
          });
          await patchLead(updated.id, {
            winSmsSentAt: nowIso(),
            winSmsError: undefined,
            smsLastSid: sent.sid,
            smsLastSentAt: nowIso(),
            smsLastType: "booking-confirmation",
            smsLastError: undefined,
            notes: `${updated.notes || ""}\nbookingConfirmationSmsSid=${sent.sid || ""}`.trim()
          });
        }
      }
    }

    return {
      ok: true,
      booked: true,
      leadId,
      invitee: {
        uri: booking?.uri,
        status: booking?.status,
        event: booking?.event,
        cancelUrl: booking?.cancelUrl,
        rescheduleUrl: booking?.rescheduleUrl,
        timezone: booking?.timezone,
        startTime: booking?.startTime
      }
    };
  }

  if (normalized === "sync_ghl_contact" || normalized === "sync_contact_to_ghl") {
    const foundLead = await findLeadByIdentity({
      leadId: safeString(args.leadId),
      phone: safeString(args.phone) || extractPhoneFromToolPayload(payload),
      email: safeString(args.email)
    });

    let lead = foundLead;
    let fallbackLeadCreated = false;

    if (!lead) {
      lead = await createFallbackLeadForGhlSync({
        phone: safeString(args.phone) || extractPhoneFromToolPayload(payload),
        email: safeString(args.email),
        firstName: safeString(args.firstName) || extractFirstNameFromToolPayload(payload),
        lastName: safeString(args.lastName),
        fullName: safeString(args.name) || safeString(args.fullName),
        company: safeString(args.company),
        campaign: safeString(args.campaign),
        notes: safeString(args.notes),
        outcome: safeString(args.outcome),
        transcript: safeString(args.transcript),
        bookingSource: safeString(args.bookingSource) || "ghl-fallback",
        callId: safeString(args.callId) || getCallId(payload)
      });
      fallbackLeadCreated = Boolean(lead);
    }

    if (!lead) {
      return {
        ok: false,
        error: "Lead not found for GHL sync, and fallback creation requires a valid phone number."
      };
    }

    await syncLeadAfterAttempt(lead, {
      outcome: safeString(args.outcome) || lead.outcome || "ghl_sync_imported",
      transcript: safeString(args.transcript) || lead.transcript,
      bookingSource: safeString(args.bookingSource) || lead.bookingSource,
      force: asBool(args.force, true)
    });

    const latest = await findLeadById(lead.id);
    if (fallbackLeadCreated) {
      runtimeInfo("ghl", "Fallback lead created for sync_ghl_contact", {
        leadId: lead.id,
        phone: lead.phone,
        ghlContactId: latest?.ghlContactId || ""
      });
    }

    return {
      ok: true,
      leadId: lead.id,
      fallbackLeadCreated,
      ghlContactId: latest?.ghlContactId,
      ghlSyncedAt: latest?.ghlSyncedAt,
      ghlLastError: latest?.ghlLastError
    };
  }

  return {
    ok: false,
    error: `Unsupported tool name: ${tool.name}`,
    supportedTools: supportedSchedulingToolNames()
  };
}

function inboundPatchFromPayload(payload: Record<string, unknown>): Partial<InboundProfile> {
  const asTrimmedString = (value: unknown): string | undefined =>
    typeof value === "string" ? value.trim() : undefined;

  const bookingProviderRaw = safeString(payload.bookingProvider)?.toLowerCase();
  const bookingProvider =
    bookingProviderRaw === "calendly"
      ? "calendly"
      : bookingProviderRaw === "google" || bookingProviderRaw === "google-calendar"
      ? "google-calendar"
      : bookingProviderRaw === "none"
      ? "none"
      : undefined;

  const voiceRaw = safeString(payload.voiceProfile)?.toLowerCase();
  const voiceProfile = voiceRaw === "male" ? "male" : voiceRaw === "female" ? "female" : undefined;

  return {
    assistantId: asTrimmedString(payload.assistantId),
    phoneNumberId: asTrimmedString(payload.phoneNumberId),
    bookingProvider,
    bookingUrl: asTrimmedString(payload.bookingUrl),
    voiceProfile,
    brandName: asTrimmedString(payload.brandName),
    objective: asTrimmedString(payload.objective),
    maxCallSeconds: asOptionalInt(payload.maxCallSeconds, 30, 300),
    waitForUser: asOptionalBool(payload.waitForUser),
    enabled: asOptionalBool(payload.enabled)
  };
}

export function createServer() {
  const app = express();
  app.use(
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString("utf8");
      }
    })
  );

  app.use("/dashboard", express.static(path.resolve(process.cwd(), "public")));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, at: nowIso() });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.redirect("/dashboard");
  });

  app.get("/api/requirements", async (_req: Request, res: Response) => {
    const templateState = await loadTemplateState();
      res.json({
      ok: true,
      requiredForTestCall: [
        "Vapi API key",
        "Vapi phone number ID (or Twilio SID/Auth/Number fallback)",
        "Assistant ID (or female/male assistant IDs)"
      ],
      webhooks: {
        vapiWebhookUrl: "/webhooks/vapi",
        meetingBookedWebhookUrl: "/webhooks/meeting-booked",
        calendlyWebhookUrl: "/webhooks/calendly",
        googleCalendarWebhookUrl: "/webhooks/google-calendar",
        vapiCustomToolsUrl: "/tools/vapi"
      },
      defaults: {
        hasEnvApiKey: Boolean(config.vapiApiKey),
        hasEnvPublicKey: Boolean(config.vapiPublicKey),
        vapiCreditGuardEnabled: config.vapiCreditGuardEnabled,
        vapiMinCreditsToDial: config.vapiMinCreditsToDial,
        vapiCreditCheckIntervalSeconds: config.vapiCreditCheckIntervalSeconds,
        hasEnvPhoneNumberId: Boolean(config.vapiPhoneNumberId),
        hasEnvAssistantId: Boolean(config.vapiAssistantId),
        hasEnvInboundAssistantId: Boolean(config.vapiInboundAssistantId),
        hasEnvFemaleAssistantId: Boolean(config.vapiAssistantIdFemale),
        hasEnvMaleAssistantId: Boolean(config.vapiAssistantIdMale),
        hasEnvTwilioAccountSid: Boolean(config.twilioAccountSid),
        hasEnvTwilioAuthToken: Boolean(config.twilioAuthToken),
        hasEnvTwilioPhoneNumber: Boolean(config.twilioPhoneNumber),
        canSendWinSms: canSendWinSms(),
        hasCalendlyAccessToken: Boolean(config.calendlyAccessToken),
        hasGeminiApiKey: isGeminiConfigured(),
        geminiModel: config.geminiModel,
        hasXaiApiKey: Boolean(config.xaiApiKey),
        xaiModel: config.xaiModel,
        hasFirecrawlApiKey: Boolean(config.firecrawlApiKey),
        hasGoogleApiKey: Boolean(config.googleApiKey),
        hasGoogleCseId: Boolean(config.googleCseId),
        hasDataForSeoAuth: Boolean(config.dataForSeoLogin && config.dataForSeoPassword),
        hasApolloApiKey: Boolean(config.apolloApiKey),
        hasDatabaseState: Boolean(config.databaseUrl),
        bookingProvider: config.bookingProvider,
        hasCalendlyBookingUrl: Boolean(config.bookingUrlCalendly),
        hasGoogleBookingUrl: Boolean(config.bookingUrlGoogleCalendar),
        hasGhlConnection: isGhlConfigured(),
        postCallDelaySeconds: config.postCallDelaySeconds,
        retargetAutoExport: config.retargetAutoExport,
        retargetDir: config.retargetDir,
        bulkSchedulerEnabled: config.bulkSchedulerEnabled,
        bulkSchedulerTimezone: config.bulkSchedulerTimezone,
        bulkSchedulerHours: config.bulkSchedulerHours,
        bulkSchedulerBatchSize: config.bulkSchedulerBatchSize,
        templateCount: Object.keys(templateState.templates).length,
        activeTemplateId: templateState.activeTemplateId,
        toolCatalogSize: TOOL_CATALOG.length
      }
    });
  });

  app.get("/api/dialer/status", async (_req: Request, res: Response) => {
    const now = Date.now();
    const leads = await withState((state) => Object.values(state.leads).map((lead) => ({ ...lead })));
    const vapiCreditGuard = await getVapiCreditGuardStatus();
    const queue = summarizeLeadQueue(leads);
    const dueNow = leads.filter((lead) => {
      if (!(lead.status === "queued" || lead.status === "retry")) return false;
      if (!lead.nextAttemptAt) return true;
      const dueAt = Date.parse(lead.nextAttemptAt);
      return !Number.isFinite(dueAt) || dueAt <= now;
    }).length;

    res.json({
      ok: true,
      runtime: {
        dialerActive: process.env.DIALER_RUNTIME === "enabled",
        runIngestOnStart: config.runIngestOnStart,
        ingestIntervalHours: config.ingestIntervalHours,
        dialerTickMs: config.dialerTickMs,
        postCallDelaySeconds: config.postCallDelaySeconds,
        requireOptIn: config.requireOptIn,
        trustAllImports: config.trustAllImports,
        reconcileIntervalSeconds: config.reconcileIntervalSeconds,
        reconcileMinAgeSeconds: config.reconcileMinAgeSeconds,
        cooldownRemainingMs: getDialerCooldownRemainingMs(),
        vapiCreditGuard
      },
      throttles: {
        effectiveCps: effectiveCps(),
        twilioCps: config.twilioCps,
        vapiCallCreateRps: config.vapiCallCreateRps,
        systemCps: config.systemCps,
        maxConcurrentDials: config.maxConcurrentDials
      },
      queue: {
        totalLeads: leads.length,
        dueNow,
        byStatus: queue
      }
    });
  });

  app.post("/api/dialer/reset-stuck", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const thresholdSeconds = asOptionalInt(body.thresholdSeconds, 30, 7200) || 180;
    const result = await resetStuckDialingLeads(thresholdSeconds);
    runtimeInfo("dialer", "reset stuck dialing requested", result);
    res.json({ ok: true, result });
  });

  app.post("/api/dialer/reconcile", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const minAgeSeconds = asOptionalInt(body.minAgeSeconds, 30, 86_400) || config.reconcileMinAgeSeconds;
    const limit = asOptionalInt(body.limit, 1, 1000) || 200;
    const result = await reconcileDialingCalls({ minAgeSeconds, limit, source: "manual-api" });
    res.json({ ok: true, result });
  });

  app.get("/api/bulk-scheduler/status", async (_req: Request, res: Response) => {
    const status = await getBulkCampaignSchedulerStatus();
    res.json({ ok: true, ...status });
  });

  app.post("/api/bulk-scheduler/toggle", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const enabled = asOptionalBool(body.enabled);
    if (enabled === undefined) {
      res.status(400).json({ ok: false, error: "enabled must be true or false" });
      return;
    }
    const settings = await setBulkCampaignSchedulerEnabled(enabled);
    const status = await getBulkCampaignSchedulerStatus();
    res.json({ ok: true, settings, status });
  });

  app.post("/api/bulk-scheduler/settings", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const scheduleHoursRaw = Array.isArray(body.scheduleHours)
      ? body.scheduleHours
      : typeof body.scheduleHours === "string"
      ? body.scheduleHours.split(",")
      : [];
    const parsedScheduleHours = scheduleHoursRaw
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.min(23, Math.max(0, Math.trunc(value))));

    const patch: Parameters<typeof updateBulkCampaignSchedulerSettings>[0] = {
      timezone: safeString(body.timezone),
      campaignName: safeString(body.campaignName),
      runWindowMinutes: asOptionalInt(body.runWindowMinutes, 1, 15),
      batchSize: asOptionalInt(body.batchSize, 1, 200),
      samplePoolSize: asOptionalInt(body.samplePoolSize, 50, 2000),
      enabled: asOptionalBool(body.enabled)
    };
    if (parsedScheduleHours.length > 0) {
      patch.scheduleHours = parsedScheduleHours;
    }

    const settings = await updateBulkCampaignSchedulerSettings(patch);
    const status = await getBulkCampaignSchedulerStatus();
    res.json({ ok: true, settings, status });
  });

  app.post("/api/bulk-scheduler/run", async (_req: Request, res: Response) => {
    const run = await runBulkSchedulerCampaign("manual");
    const status = await getBulkCampaignSchedulerStatus();
    res.json({ ok: true, run, status });
  });

  app.get("/api/voices/status", async (_req: Request, res: Response) => {
    const data = await getVoicesDashboard();
    res.json({ ok: true, ...data });
  });

  app.post("/api/voices/profile", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const name = safeString(body.name);
    if (!name) {
      res.status(400).json({ ok: false, error: "name is required" });
      return;
    }

    const profile = await upsertVoiceProfile({
      id: safeString(body.id),
      name,
      ownerName: safeString(body.ownerName),
      assistantId: safeString(body.assistantId),
      calendarUrl: safeString(body.calendarUrl),
      campaignName: safeString(body.campaignName),
      firstMessage: safeString(body.firstMessage),
      systemPrompt: safeString(body.systemPrompt),
      llmProvider: safeString(body.llmProvider),
      llmModel: safeString(body.llmModel),
      llmTemperature: typeof body.llmTemperature === "number" ? body.llmTemperature : Number(body.llmTemperature),
      transcriberProvider: safeString(body.transcriberProvider),
      transcriberModel: safeString(body.transcriberModel),
      defaultBatchSize: asOptionalInt(body.defaultBatchSize, 1, 200),
      defaultSamplePoolSize: asOptionalInt(body.defaultSamplePoolSize, 50, 2000),
      active: asOptionalBool(body.active)
    });

    runtimeInfo("agent", "voices profile upserted", {
      profileId: profile.id,
      assistantId: profile.assistantId || "",
      ownerName: profile.ownerName || ""
    });
    res.json({ ok: true, profile });
  });

  app.post("/api/voices/profile/:id/delete", async (req: Request, res: Response) => {
    const removed = await deleteVoiceProfile(req.params.id);
    if (!removed) {
      res.status(404).json({ ok: false, error: "Voice profile not found" });
      return;
    }
    res.json({ ok: true, deleted: req.params.id });
  });

  app.post("/api/voices/profile/:id/spin-up", async (req: Request, res: Response) => {
    try {
      const result = await spinUpAssistantForProfile(req.params.id);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/voices/profile/:id/run", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    try {
      const run = await runVoiceBatchCampaign(req.params.id, {
        trigger: "manual",
        batchSize: asOptionalInt(body.batchSize, 1, 200),
        samplePoolSize: asOptionalInt(body.samplePoolSize, 50, 2000),
        campaignName: safeString(body.campaignName)
      });
      const status = await getVoicesDashboard();
      res.json({ ok: true, run, status });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/voices/profile/:id/upload-run", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const csvContent = typeof body.csvContent === "string" ? body.csvContent : "";
    if (!csvContent.trim()) {
      res.status(400).json({ ok: false, error: "csvContent is required" });
      return;
    }

    try {
      const run = await runVoiceCsvCampaign(req.params.id, {
        csvContent,
        fileName: safeString(body.fileName),
        campaignName: safeString(body.campaignName),
        trustImportLeads: asOptionalBool(body.trustImportLeads)
      });
      const status = await getVoicesDashboard();
      res.json({ ok: true, run, status });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/logs/worker", (req: Request, res: Response) => {
    const scopeRaw = safeString(req.query.scope)?.toLowerCase();
    const scope =
      scopeRaw === "worker" ||
      scopeRaw === "dialer" ||
      scopeRaw === "ingest" ||
      scopeRaw === "webhook" ||
      scopeRaw === "server" ||
      scopeRaw === "ghl" ||
      scopeRaw === "agent" ||
      scopeRaw === "twilio" ||
      scopeRaw === "vapi" ||
      scopeRaw === "scheduler"
        ? scopeRaw
        : undefined;
    const limit = asOptionalInt(req.query.limit, 1, 1000) || 200;
    const afterTs = asOptionalInt(req.query.afterTs, 0, Number.MAX_SAFE_INTEGER);
    const logs = listRuntimeLogs({ scope, afterTs, limit });
    const latestTs = logs.length ? logs[logs.length - 1].ts : latestRuntimeLogTs(scope);
    res.json({ ok: true, scope: scope || "all", afterTs: afterTs || 0, latestTs, count: logs.length, logs });
  });

  app.post("/api/ingest/upload", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const filesRaw = Array.isArray(body.files) ? body.files : [body];

    const files = filesRaw
      .map((item) => asObject(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => ({
        fileName: safeString(item.fileName) || "upload.csv",
        csvContent: typeof item.csvContent === "string" ? item.csvContent : ""
      }))
      .filter((item) => item.csvContent.trim().length > 0);

    if (files.length === 0) {
      res.status(400).json({ ok: false, error: "Provide files[].fileName and files[].csvContent" });
      return;
    }

    await fs.mkdir(config.incomingDir, { recursive: true });
    const stamp = nowIso().replace(/[:.]/g, "-");

    const uploaded: Array<{ fileName: string; storedAs: string; bytes: number }> = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const safeName = sanitizeCsvFilename(file.fileName, `upload-${i + 1}.csv`);
      const storedAs = `upload-${stamp}-${i + 1}-${safeName}`;
      const fullPath = path.resolve(config.incomingDir, storedAs);
      await fs.writeFile(fullPath, file.csvContent, "utf8");
      uploaded.push({
        fileName: file.fileName,
        storedAs,
        bytes: Buffer.byteLength(file.csvContent, "utf8")
      });
    }

    const runIngest = asBool(body.runIngest, true);
    const summaries = runIngest ? await ingestOnce() : [];
    const leads = await withState((state) => Object.values(state.leads).map((lead) => ({ ...lead })));
    const accepted = summaries.reduce((sum, row) => sum + (row.accepted || 0), 0);
    runtimeInfo(
      "ingest",
      `dashboard upload processed files=${uploaded.length} runIngest=${runIngest} accepted=${accepted} queue=${leads.length}`
    );

    res.json({
      ok: true,
      uploaded,
      ingest: {
        ran: runIngest,
        summaries
      },
      queue: {
        totalLeads: leads.length,
        byStatus: summarizeLeadQueue(leads)
      }
    });
  });

  app.post("/api/ingest/run", async (_req: Request, res: Response) => {
    const summaries = await ingestOnce();
    const leads = await withState((state) => Object.values(state.leads).map((lead) => ({ ...lead })));
    const accepted = summaries.reduce((sum, row) => sum + (row.accepted || 0), 0);
    runtimeInfo("ingest", `manual ingest run files=${summaries.length} accepted=${accepted} queue=${leads.length}`);

    res.json({
      ok: true,
      summaries,
      queue: {
        totalLeads: leads.length,
        byStatus: summarizeLeadQueue(leads)
      }
    });
  });

  app.post("/api/ghl/import-smart-list", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const filterId = safeString(body.filterId);
    if (!filterId) {
      res.status(400).json({ ok: false, error: "filterId is required" });
      return;
    }

    const pageLimit = asOptionalInt(body.pageLimit, 10, 200) || 100;
    const maxPages = asOptionalInt(body.maxPages, 1, 50) || 10;
    const runIngest = asBool(body.runIngest, true);
    const sourceLabel = safeString(body.sourceLabel) || "ghl-smart-list";
    runtimeInfo("ghl", "smart list import requested", { filterId, pageLimit, maxPages, runIngest });

    try {
      const result = await fetchSmartListContacts(filterId, { pageLimit, maxPages });
      const rows = result.contacts
        .filter((contact) => Boolean(contact.phone))
        .map((contact) => ({
          phone: contact.phone || "",
          first_name: contact.firstName || "",
          last_name: contact.lastName || "",
          company: contact.companyName || "",
          email: contact.email || "",
          timezone: contact.timezone || config.defaultTimezone,
          opt_in: "true",
          dnc: "false",
          findings: `Imported from GHL smart list ${filterId}`,
          notes: `${sourceLabel} contactId=${contact.id || ""}`
        }));

      if (rows.length === 0) {
        res.status(400).json({
          ok: false,
          error: "No contacts with phone numbers found for this smart list filterId.",
          fetchedContacts: result.contacts.length,
          attempts: result.attempts
        });
        return;
      }

      await fs.mkdir(config.incomingDir, { recursive: true });
      const stamp = nowIso().replace(/[:.]/g, "-");
      const fileName = sanitizeCsvFilename(`${sourceLabel}-${filterId}-${stamp}.csv`, `ghl-${filterId}.csv`);
      const csv = rowsToCsv(
        ["phone", "first_name", "last_name", "company", "email", "timezone", "opt_in", "dnc", "findings", "notes"],
        rows
      );
      const filePath = path.resolve(config.incomingDir, fileName);
      await fs.writeFile(filePath, csv, "utf8");

      const summaries = runIngest ? await ingestOnce() : [];
      const leads = await withState((state) => Object.values(state.leads).map((lead) => ({ ...lead })));
      runtimeInfo("ghl", "smart list import completed", {
        filterId,
        fetched: result.contacts.length,
        rowsWritten: rows.length,
        runIngest,
        queue: leads.length
      });

      res.json({
        ok: true,
        filterId,
        fetchedContacts: result.contacts.length,
        contactsWithPhone: rows.length,
        writtenFile: { fileName, bytes: Buffer.byteLength(csv, "utf8") },
        attempts: result.attempts,
        ingest: {
          ran: runIngest,
          summaries
        },
        queue: {
          totalLeads: leads.length,
          byStatus: summarizeLeadQueue(leads)
        }
      });
    } catch (error) {
      runtimeError("ghl", "smart list import failed", error, { filterId });
      res.status(500).json({
        ok: false,
        error: String(error),
        guide: {
          message:
            "If your account does not expose smart-list filtering through API, export contacts from GHL UI as CSV and upload with GO.",
          docsUrl: "https://developers.gohighlevel.com/",
          dashboardUrl: "https://app.gohighlevel.com/"
        }
      });
    }
  });

  app.get("/api/prospector/runs", async (_req: Request, res: Response) => {
    res.json({ ok: true, runs: listProspectorRuns() });
  });

  app.get("/api/prospector/records", async (req: Request, res: Response) => {
    const limit = asOptionalInt(req.query.limit, 1, 1000) || 200;
    const records = await listProspectorPhaseRecords(limit);
    res.json({
      ok: true,
      writable: canWriteProspectorRecords(),
      count: records.length,
      records
    });
  });

  app.get("/api/prospector/leads", async (req: Request, res: Response) => {
    const websiteStatus = safeString(req.query.websiteStatus)?.toLowerCase();
    const limit = asOptionalInt(req.query.limit, 1, 500) || 200;
    const leads = await withState((state) => {
      return Object.values(state.leads)
        .filter((lead) => lead.sourceFile === "prospector-dashboard")
        .filter((lead) => !websiteStatus || (lead.prospectWebsiteStatus || "").toLowerCase() === websiteStatus)
        .sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""))
        .slice(0, limit)
        .map((lead) => ({
          id: lead.id,
          company: lead.company,
          phone: lead.phone,
          status: lead.status,
          prospectWebsiteStatus: lead.prospectWebsiteStatus,
          prospectCity: lead.prospectCity,
          prospectState: lead.prospectState,
          prospectAddress: lead.prospectAddress,
          prospectWebsiteUri: lead.prospectWebsiteUri,
          prospectWebsiteTitle: lead.prospectWebsiteTitle,
          prospectWebsiteDescription: lead.prospectWebsiteDescription,
          prospectWebsiteSnippet: lead.prospectWebsiteSnippet,
          prospectWebsiteEmail: lead.prospectWebsiteEmail,
          prospectWebsitePhone: lead.prospectWebsitePhone,
          prospectRating: lead.prospectRating,
          prospectReviewCount: lead.prospectReviewCount,
          prospectBusinessStatus: lead.prospectBusinessStatus,
          prospectCategories: lead.prospectCategories,
          prospectDataSources: lead.prospectDataSources,
          prospectScore: lead.prospectScore,
          prospectOpportunityScore: lead.prospectOpportunityScore,
          prospectScoreReason: lead.prospectScoreReason,
          prospectScoreProvider: lead.prospectScoreProvider,
          prospectorPhase: lead.prospectorPhase,
          prospectorPhaseStatus: lead.prospectorPhaseStatus,
          prospectorTemplateSource: lead.prospectorTemplateSource,
          prospectorTemplateModel: lead.prospectorTemplateModel,
          prospectorPromptVersion: lead.prospectorPromptVersion,
          generationStatus: lead.generationStatus,
          prospectDeployName: lead.prospectDeployName,
          generatedSitePath: lead.generatedSitePath,
          generatedScreenshotPath: lead.generatedScreenshotPath,
          deployedSiteUrl: lead.deployedSiteUrl,
          prospectorGhlContactId: lead.prospectorGhlContactId || lead.ghlContactId,
          prospectorGhlSyncedAt: lead.prospectorGhlSyncedAt,
          hasProspectorVoiceScript: Boolean(lead.prospectorVoiceScript),
          hasProspectorVoiceVariables: Boolean(lead.prospectorVoiceVariables),
          bookingUrl: 'https://cal.com/trd-voice/intro',
          handoffStatus: lead.handoffStatus,
          updatedAt: lead.updatedAt
        }));
    });
    res.json({ ok: true, count: leads.length, leads });
  });

  app.get("/api/prospector/site/:leadId", async (req: Request, res: Response) => {
    const leadId = safeString(req.params.leadId);
    if (!leadId) {
      res.status(400).send("Missing leadId");
      return;
    }

    const lead = await withState((state) => {
      const row = state.leads[leadId];
      if (!row || row.sourceFile !== "prospector-dashboard") return undefined;
      return { ...row };
    });
    if (!lead?.generatedSitePath) {
      res.status(404).send("Prospector site not found");
      return;
    }

    const resolvedPath = path.resolve(lead.generatedSitePath);
    const allowedRoot = path.resolve(config.generatedSitesDir) + path.sep;
    if (!resolvedPath.startsWith(allowedRoot)) {
      res.status(403).send("Prospector site path is outside allowed directory");
      return;
    }

    try {
      const html = await fs.readFile(resolvedPath, "utf8");
      res.type("html").send(html);
    } catch {
      res.status(404).send("Prospector site file not found");
    }
  });

  app.post("/api/prospector/generate-sites", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const limit = asOptionalInt(body.limit, 1, 100) || 10;
    const result = await generateReadyProspectSites(limit);
    res.json({ ok: true, result });
  });

  app.post("/api/prospector/generate-screenshots", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const limit = asOptionalInt(body.limit, 1, 100) || 10;
    const result = await createProspectScreenshots(limit);
    res.json({ ok: true, result });
  });

  app.post("/api/prospector/ready-for-call", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const leadId = safeString(body.leadId);
    if (!leadId) {
      res.status(400).json({ ok: false, error: "leadId is required" });
      return;
    }
    const result = await markProspectReadyForCall(leadId);
    if (!result.updated) {
      res.status(400).json({ ok: false, error: result.reason || 'Could not update lead' });
      return;
    }
    res.json({ ok: true, result });
  });

  app.post("/api/prospector/release-to-queue", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const leadId = safeString(body.leadId);
    if (!leadId) {
      res.status(400).json({ ok: false, error: "leadId is required" });
      return;
    }
    const result = await releaseProspectToQueue(leadId);
    if (!result.updated) {
      res.status(400).json({ ok: false, error: result.reason || 'Could not release lead' });
      return;
    }
    res.json({ ok: true, result });
  });

  app.post("/api/prospector/deploy-sites", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const limit = asOptionalInt(body.limit, 1, 100) || 10;
    const result = await deployGeneratedProspects(limit);
    const phase3 = await runProspectorPhase3(limit);
    res.json({ ok: true, result, phase3 });
  });

  app.post("/api/prospector/phase1", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const icp = safeString(body.icp);
    const city = safeString(body.city);
    const stateValue = safeString(body.state);
    if (!icp || !city || !stateValue) {
      res.status(400).json({ ok: false, error: "phase1 requires icp, city, and state" });
      return;
    }
    try {
      const run = await startProspectorRun({ icp, city, state: stateValue });
      res.json({ ok: true, phase: 1, run });
    } catch (error) {
      res.status(500).json({ ok: false, phase: 1, error: String(error) });
    }
  });

  app.post("/api/prospector/phase2", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const limit = asOptionalInt(body.limit, 1, 100) || 10;
    try {
      const result = await runProspectorPhase2(limit);
      res.json({ ok: true, phase: 2, result });
    } catch (error) {
      res.status(500).json({ ok: false, phase: 2, error: String(error) });
    }
  });

  app.post("/api/prospector/phase3", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const limit = asOptionalInt(body.limit, 1, 500) || 100;
    try {
      const result = await runProspectorPhase3(limit);
      res.json({ ok: true, phase: 3, result });
    } catch (error) {
      res.status(500).json({ ok: false, phase: 3, error: String(error) });
    }
  });

  app.post("/api/prospector/phase4", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const limit = asOptionalInt(body.limit, 1, 500) || 100;
    try {
      const result = await runProspectorPhase4(limit);
      res.json({ ok: true, phase: 4, result });
    } catch (error) {
      res.status(500).json({ ok: false, phase: 4, error: String(error) });
    }
  });

  app.post("/api/prospector/phase5", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    try {
      const result = await runProspectorPhase5({
        limit: asOptionalInt(body.limit, 1, 100) || 10,
        leadId: safeString(body.leadId),
        dryRun: asBool(body.dryRun, false),
        assistantId: safeString(body.assistantId)
      });
      res.json({ ok: true, phase: 5, result });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/prospector/pipeline", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    try {
      const result = await runProspectorPipeline({
        icp: safeString(body.icp),
        city: safeString(body.city),
        state: safeString(body.state),
        limit: asOptionalInt(body.limit, 1, 100) || 10,
        runPhase1: asBool(body.runPhase1, false),
        runPhase2: body.runPhase2 === undefined ? true : asBool(body.runPhase2, true),
        runPhase3: body.runPhase3 === undefined ? true : asBool(body.runPhase3, true),
        runPhase4: body.runPhase4 === undefined ? true : asBool(body.runPhase4, true),
        runPhase5: asBool(body.runPhase5, false),
        dryRunCalls: asBool(body.dryRunCalls, false),
        assistantId: safeString(body.assistantId)
      });
      res.json({ ok: true, result });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/prospector/create-vision-assistant", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const attachTools = asBool(body.attachTools, true);
    const includeGhlSyncTool = asBool(body.includeGhlSyncTool, true);
    const strictTools = asBool(body.strictTools, true);
    const serverUrl = asHttpUrl(body.serverUrl) || `${requestBaseUrl(req)}/tools/vapi`;
    const modeRaw = safeString(body.mode)?.toLowerCase();
    const mode: "replace" | "append" | "remove" =
      modeRaw === "replace" || modeRaw === "remove" ? modeRaw : "append";

    try {
      const template = createProspectVisionTemplate();
      const created = await createVapiAssistantFromTemplate(template);
      const toolErrors: string[] = [];
      let attachedToolIds: string[] = [];

      if (attachTools) {
        const toolPayloads = buildSchedulingToolPayloads({
          serverUrl,
          strict: strictTools,
          includeGhlSyncTool
        });

        const createdToolIds: string[] = [];
        for (const tool of toolPayloads) {
          try {
            const createdTool = await createVapiTool(tool);
            const id = safeString(createdTool.id);
            if (id) createdToolIds.push(id);
          } catch (error) {
            toolErrors.push(String(error).slice(0, 300));
          }
        }

        if (createdToolIds.length > 0) {
          try {
            const attach = await setAssistantToolIds(created.id, createdToolIds, { mode });
            attachedToolIds = attach.toolIds;
          } catch (error) {
            toolErrors.push(`attach_failed: ${String(error).slice(0, 300)}`);
          }
        }
      }

      res.json({
        ok: true,
        assistantId: created.id,
        assistant: created.raw,
        tools: {
          attachTools,
          serverUrl: attachTools ? serverUrl : undefined,
          attachedToolIds,
          errors: toolErrors
        }
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/demo/create-tony-assistant", async (_req: Request, res: Response) => {
    try {
      const template = createTonyDemoTemplate();
      const created = await createVapiAssistantFromTemplate(template);
      res.json({ ok: true, assistantId: created.id, assistant: created.raw });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/demo/test-tony-call", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const toNumber = normalizePhone(safeString(body.toNumber) || '');
    const assistantId = safeString(body.assistantId) || config.vapiAssistantId;
    if (!toNumber) {
      res.status(400).json({ ok: false, error: 'Invalid toNumber' });
      return;
    }
    if (!assistantId) {
      res.status(400).json({ ok: false, error: 'Missing assistantId' });
      return;
    }

    const payload = {
      assistantId,
      customer: {
        number: toNumber,
        name: 'Tony'
      },
      phoneNumber: {
        twilioPhoneNumber: config.twilioPhoneNumber,
        twilioAccountSid: config.twilioAccountSid,
        twilioAuthToken: config.twilioAuthToken
      },
      assistantOverrides: {
        variableValues: {
          leadFirstName: 'Tony',
          leadCompany: '',
          demoOffer: 'This is a short friendly demo of our AI voice agent.',
          complianceNote: 'Be clear that you are Jarvis, an AI agent from True Rank Digital.'
        }
      },
      metadata: {
        leadId: 'tony-demo-call',
        campaign: 'Tony Demo',
        sourceFile: 'demo-call'
      }
    };

    try {
      const response = await fetch(`${config.vapiBaseUrl}/call`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.vapiApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const raw = await response.text();
      if (!response.ok) {
        res.status(500).json({ ok: false, error: raw });
        return;
      }
      const parsed = JSON.parse(raw) as { id: string };
      res.json({ ok: true, callId: parsed.id, assistantId });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/prospector/start", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const icp = safeString(body.icp);
    const city = safeString(body.city);
    const stateValue = safeString(body.state);

    if (!icp || !city || !stateValue) {
      res.status(400).json({ ok: false, error: "icp, city, and state are required" });
      return;
    }

    const run = await startProspectorRun({ icp, city, state: stateValue });
    res.json({ ok: true, run });
  });

  app.post("/api/booking/test", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const provider = safeString(body.provider)?.toLowerCase() || "calendly";
    const sendSms = asBool(body.sendSms, false);

    const lead = await findLeadByIdentity({
      leadId: safeString(body.leadId),
      phone: safeString(body.phone),
      email: safeString(body.email)
    });

    if (!lead) {
      res.status(404).json({ ok: false, error: "Lead not found for booking test" });
      return;
    }

    const source =
      provider === "google" || provider === "google-calendar"
        ? "google-calendar"
        : provider === "calendly"
        ? "calendly"
        : "manual-test";

    const updated = await markLeadBooked(lead, source);
    if (!updated) {
      res.status(500).json({ ok: false, error: "Could not update lead booking state" });
      return;
    }

    await syncLeadAfterAttempt(updated, {
      outcome: "booked",
      transcript: updated.transcript,
      bookingSource: source,
      force: true
    });
    if (sendSms) {
      await maybeSendWinSms(updated, "booked");
    }

    res.json({
      ok: true,
      leadId: updated.id,
      bookingSource: source,
      status: updated.status,
      smsTriggered: sendSms
    });
  });

  app.get("/api/rule-packs", (_req: Request, res: Response) => {
    res.json({ ok: true, rulePacks: RULE_PACKS });
  });

  app.get("/api/inbound/profile", async (_req: Request, res: Response) => {
    const profile = await loadInboundProfile();
    const phases = inboundPhasePlan(profile);
    res.json({ ok: true, profile, phases });
  });

  app.get("/api/inbound/phases", async (_req: Request, res: Response) => {
    const profile = await loadInboundProfile();
    res.json({ ok: true, phases: inboundPhasePlan(profile) });
  });

  app.post("/api/inbound/profile", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const profilePayload = asObject(body.profile) || body;
    const patch = inboundPatchFromPayload(profilePayload);
    const profile = await saveInboundProfilePatch(patch);
    res.json({ ok: true, profile, phases: inboundPhasePlan(profile) });
  });

  app.post("/api/inbound/attach-phone", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const current = await loadInboundProfile();
    const assistantId = safeString(body.assistantId) || current.assistantId;
    const phoneNumberId = safeString(body.phoneNumberId) || current.phoneNumberId;

    if (!assistantId || !phoneNumberId) {
      res.status(400).json({
        ok: false,
        error: "assistantId and phoneNumberId are required",
        guide: {
          docsUrl: "https://docs.vapi.ai/api-reference/phone-numbers/update",
          dashboardUrl: "https://dashboard.vapi.ai/phone-numbers"
        }
      });
      return;
    }

    try {
      const phoneNumber = await attachAssistantToVapiPhoneNumber(phoneNumberId, assistantId, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl),
        serverUrl: safeString(body.serverUrl)
      });

      const profile = await saveInboundProfilePatch({
        assistantId,
        phoneNumberId
      });

      res.json({
        ok: true,
        profile,
        phases: inboundPhasePlan(profile),
        phoneNumber,
        guide: {
          docsUrl: "https://docs.vapi.ai/api-reference/phone-numbers/update",
          dashboardUrl: "https://dashboard.vapi.ai/phone-numbers"
        }
      });
    } catch (error) {
      if (error instanceof VapiPhoneNumberError) {
        res.status(502).json({
          ok: false,
          error: error.message,
          status: error.status,
          details: error.body,
          guide: {
            message:
              "If this provider payload is restricted in API mode, update the phone number assignment in the Vapi dashboard.",
            docsUrl: "https://docs.vapi.ai/api-reference/phone-numbers/update",
            dashboardUrl: "https://dashboard.vapi.ai/phone-numbers"
          }
        });
        return;
      }

      res.status(500).json({
        ok: false,
        error: String(error),
        guide: {
          docsUrl: "https://docs.vapi.ai/api-reference/phone-numbers/update",
          dashboardUrl: "https://dashboard.vapi.ai/phone-numbers"
        }
      });
    }
  });

  app.get("/api/templates", async (_req: Request, res: Response) => {
    const state = await loadTemplateState();
    const templates = Object.values(state.templates).sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      ok: true,
      activeTemplateId: state.activeTemplateId,
      templates
    });
  });

  app.post("/api/templates/create-default", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const name = safeString(body.name) || "New Agent Template";
    const created = createDefaultTemplate(name);

    await withTemplateState((state) => {
      state.templates[created.id] = created;
      state.activeTemplateId = created.id;
    });

    res.json({ ok: true, template: created, activeTemplateId: created.id });
  });

  app.post("/api/templates/save", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const rawTemplate = asObject(body.template);
    if (!rawTemplate) {
      res.status(400).json({ ok: false, error: "Missing template payload" });
      return;
    }

    let saved: AgentTemplate | undefined;
    await withTemplateState((state) => {
      const existingId = typeof rawTemplate.id === "string" ? rawTemplate.id : undefined;
      const previous = existingId ? state.templates[existingId] : undefined;
      const normalized = normalizeTemplateInput(rawTemplate, previous || createDefaultTemplate());
      state.templates[normalized.id] = normalized;
      if (!state.activeTemplateId || state.activeTemplateId === previous?.id) {
        state.activeTemplateId = normalized.id;
      }
      saved = normalized;
    });

    res.json({ ok: true, template: saved });
  });

  app.post("/api/templates/:id/activate", async (req: Request, res: Response) => {
    const id = req.params.id;
    let found = false;
    await withTemplateState((state) => {
      if (!state.templates[id]) return;
      state.activeTemplateId = id;
      found = true;
    });

    if (!found) {
      res.status(404).json({ ok: false, error: "Template not found" });
      return;
    }

    res.json({ ok: true, activeTemplateId: id });
  });

  app.delete("/api/templates/:id", async (req: Request, res: Response) => {
    const id = req.params.id;
    let deleted = false;
    let nextActiveId: string | undefined;

    await withTemplateState((state) => {
      if (!state.templates[id]) return;
      delete state.templates[id];
      deleted = true;

      const ids = Object.keys(state.templates);
      if (ids.length === 0) {
        const fallback = createDefaultTemplate("Recovered Template");
        state.templates[fallback.id] = fallback;
        state.activeTemplateId = fallback.id;
        nextActiveId = fallback.id;
        return;
      }

      if (state.activeTemplateId === id) {
        state.activeTemplateId = ids[0];
      }
      nextActiveId = state.activeTemplateId;
    });

    if (!deleted) {
      res.status(404).json({ ok: false, error: "Template not found" });
      return;
    }

    res.json({ ok: true, activeTemplateId: nextActiveId });
  });

  app.get("/api/templates/:id/compile", async (req: Request, res: Response) => {
    const template = await getTemplateById(req.params.id);
    if (!template) {
      res.status(404).json({ ok: false, error: "Template not found" });
      return;
    }

    const compiled = compileTemplatePrompt(template);
    res.json({ ok: true, compiled });
  });

  app.get("/api/templates/:id/vapi-draft", async (req: Request, res: Response) => {
    const template = await getTemplateById(req.params.id);
    if (!template) {
      res.status(404).json({ ok: false, error: "Template not found" });
      return;
    }

    const draft = buildVapiAssistantDraft(template);
    res.json({ ok: true, templateId: template.id, draft });
  });

  app.post("/api/templates/compile-preview", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const rawTemplate = asObject(body.template);
    if (!rawTemplate) {
      res.status(400).json({ ok: false, error: "Missing template payload" });
      return;
    }

    const preview = normalizeTemplateInput(rawTemplate, createDefaultTemplate("Preview Template"));
    const compiled = compileTemplatePrompt(preview);
    const draft = buildVapiAssistantDraft(preview);
    res.json({ ok: true, compiled, draft });
  });

  app.get("/api/analytics/summary", async (_req: Request, res: Response) => {
    const summary = await withState((state) => {
      return computeAnalyticsSummary(Object.values(state.leads));
    });
    res.json({ ok: true, summary });
  });

  app.get("/api/retarget/summary", async (_req: Request, res: Response) => {
    const leads = await withState((state) => Object.values(state.leads).map((lead) => ({ ...lead })));
    const summary = summarizeRetargetBuckets(leads);
    res.json({ ok: true, summary });
  });

  app.post("/api/retarget/export", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const writeSnapshot = asBool(body.snapshot, true);
    const label = safeString(body.label);

    const leads = await withState((state) => Object.values(state.leads).map((lead) => ({ ...lead })));
    const result = await exportRetargetBuckets(leads, {
      writeLatest: true,
      writeSnapshot,
      label
    });

    res.json({ ok: true, result });
  });

  app.get("/api/vapi/phone-numbers", async (req: Request, res: Response) => {
    try {
      const phoneNumbers = await listVapiPhoneNumbers({
        apiKey: safeString(req.query.vapiApiKey),
        baseUrl: safeString(req.query.vapiBaseUrl)
      });
      res.json({ ok: true, phoneNumbers });
    } catch (error) {
      if (error instanceof VapiPhoneNumberError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/vapi/phone-numbers/:id", async (req: Request, res: Response) => {
    try {
      const phoneNumber = await getVapiPhoneNumber(req.params.id, {
        apiKey: safeString(req.query.vapiApiKey),
        baseUrl: safeString(req.query.vapiBaseUrl)
      });
      res.json({ ok: true, phoneNumber });
    } catch (error) {
      if (error instanceof VapiPhoneNumberError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/vapi/assistants", async (req: Request, res: Response) => {
    try {
      const assistants = await listVapiAssistants({
        apiKey: safeString(req.query.vapiApiKey),
        baseUrl: safeString(req.query.vapiBaseUrl)
      });
      res.json({ ok: true, assistants });
    } catch (error) {
      if (error instanceof VapiAssistantError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/vapi/tool-catalog", (_req: Request, res: Response) => {
    const guides = TOOL_CATALOG.filter((entry) => entry.apiSupport !== "full").map((entry) => ({
      key: entry.key,
      label: entry.label,
      docsUrl: entry.docsUrl,
      dashboardUrl: entry.dashboardUrl,
      composerPrompt: entry.composerPrompt,
      apiNotes: entry.apiNotes,
      dashboardSteps: entry.dashboardSteps || []
    }));

    res.json({
      ok: true,
      catalog: TOOL_CATALOG,
      guides,
      composer: {
        docsUrl: "https://docs.vapi.ai/composer",
        dashboardUrl: "https://dashboard.vapi.ai/composer",
        note: "Use Composer to ask Vapi AI for setup guidance and tool troubleshooting."
      }
    });
  });

  app.post("/api/vapi/tools/bootstrap", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const serverUrl = asHttpUrl(body.serverUrl) || `${requestBaseUrl(req)}/tools/vapi`;
    const strict = asBool(body.strict, true);
    const includeGhlSyncTool = asBool(body.includeGhlSyncTool, true);
    const assistantId = safeString(body.assistantId);
    const attachToAssistant = asBool(body.attachToAssistant, true);
    const modeRaw = safeString(body.mode)?.toLowerCase();
    const mode: "replace" | "append" | "remove" =
      modeRaw === "replace" || modeRaw === "remove" ? modeRaw : "append";

    const toolPayloads = buildSchedulingToolPayloads({
      serverUrl,
      strict,
      includeGhlSyncTool
    });

    try {
      const createdTools: Array<Record<string, unknown>> = [];
      for (const tool of toolPayloads) {
        const created = await createVapiTool(tool, {
          apiKey: safeString(body.vapiApiKey),
          baseUrl: safeString(body.vapiBaseUrl)
        });
        createdTools.push(created);
      }

      const createdToolIds = createdTools
        .map((tool) => safeString(tool.id))
        .filter((id): id is string => Boolean(id));

      let attached: { assistantId: string; toolIds: string[]; mode: string } | undefined;
      if (assistantId && attachToAssistant && createdToolIds.length > 0) {
        const update = await setAssistantToolIds(assistantId, createdToolIds, {
          apiKey: safeString(body.vapiApiKey),
          baseUrl: safeString(body.vapiBaseUrl),
          mode
        });
        attached = {
          assistantId,
          toolIds: update.toolIds,
          mode
        };
      }

      runtimeInfo("agent", "vapi scheduling tools bootstrapped", {
        count: createdToolIds.length,
        assistantId: assistantId || "",
        attached: Boolean(attached)
      });

      res.json({
        ok: true,
        serverUrl,
        strict,
        createdCount: createdToolIds.length,
        createdToolIds,
        createdTools,
        attached,
        supportedTools: supportedSchedulingToolNames()
      });
    } catch (error) {
      if (error instanceof VapiToolError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  const vapiToolWebhookHandler = async (req: Request, res: Response) => {
    if (!verifySecret(req)) {
      res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      return;
    }

    const payload = asObject(req.body) || {};
    const invocations = parseVapiToolInvocations(payload);
    if (invocations.length === 0) {
      res.json({ results: [] });
      return;
    }

    const results: VapiToolExecutionResult[] = [];
    for (const invocation of invocations) {
      try {
        const result = await executeSchedulingToolInvocation(invocation, payload);
        results.push({
          toolCallId: invocation.toolCallId,
          result
        });
        runtimeInfo("webhook", "vapi tool executed", {
          toolName: invocation.name,
          toolCallId: invocation.toolCallId
        });
      } catch (error) {
        runtimeError("webhook", "vapi tool execution failed", error, {
          toolName: invocation.name,
          toolCallId: invocation.toolCallId
        });
        results.push({
          toolCallId: invocation.toolCallId,
          result: {
            ok: false,
            error: String(error).slice(0, 800)
          }
        });
      }
    }

    res.json({ results });
  };

  app.post("/tools/vapi", vapiToolWebhookHandler);
  app.post("/tools/webhook", vapiToolWebhookHandler);
  app.post("/vapi/tools/webhook", vapiToolWebhookHandler);

  app.get("/api/vapi/tools", async (req: Request, res: Response) => {
    try {
      const tools = await listVapiTools({
        apiKey: safeString(req.query.vapiApiKey),
        baseUrl: safeString(req.query.vapiBaseUrl)
      });
      res.json({ ok: true, tools });
    } catch (error) {
      if (error instanceof VapiToolError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/vapi/tools", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const tool = asObject(body.tool);
    if (!tool) {
      res.status(400).json({ ok: false, error: "Missing tool payload" });
      return;
    }

    try {
      const created = await createVapiTool(tool, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl)
      });
      res.json({ ok: true, tool: created });
    } catch (error) {
      if (error instanceof VapiToolError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.patch("/api/vapi/tools/:toolId", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const patch = asObject(body.patch);
    if (!patch) {
      res.status(400).json({ ok: false, error: "Missing patch payload" });
      return;
    }

    try {
      const updated = await updateVapiTool(req.params.toolId, patch, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl)
      });
      res.json({ ok: true, tool: updated });
    } catch (error) {
      if (error instanceof VapiToolError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.delete("/api/vapi/tools/:toolId", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    try {
      const removed = await deleteVapiTool(req.params.toolId, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl)
      });
      res.json({ ok: true, tool: removed });
    } catch (error) {
      if (error instanceof VapiToolError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/vapi/assistants/:assistantId/tool-ids", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const toolIds = toStringArray(body.toolIds);
    if (toolIds.length === 0) {
      res.status(400).json({ ok: false, error: "toolIds must include at least one id" });
      return;
    }

    const modeRaw = safeString(body.mode)?.toLowerCase() || "append";
    const mode: "replace" | "append" | "remove" =
      modeRaw === "replace" || modeRaw === "remove" ? modeRaw : "append";

    try {
      const updated = await setAssistantToolIds(req.params.assistantId, toolIds, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl),
        mode
      });
      res.json({ ok: true, assistant: updated.assistant, toolIds: updated.toolIds, mode });
    } catch (error) {
      if (error instanceof VapiToolError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/vapi/assistants/:assistantId/attach-phone-number", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const phoneNumberId = safeString(body.phoneNumberId);
    if (!phoneNumberId) {
      res.status(400).json({ ok: false, error: "phoneNumberId is required" });
      return;
    }

    try {
      const phoneNumber = await attachAssistantToVapiPhoneNumber(phoneNumberId, req.params.assistantId, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl),
        serverUrl: safeString(body.serverUrl)
      });
      runtimeInfo("agent", "assistant attached to phone number", {
        assistantId: req.params.assistantId,
        phoneNumberId
      });
      res.json({ ok: true, assistantId: req.params.assistantId, phoneNumberId, phoneNumber });
    } catch (error) {
      if (error instanceof VapiPhoneNumberError) {
        res.status(500).json({
          ok: false,
          error: error.message,
          status: error.status,
          details: error.body,
          guide: {
            docsUrl: "https://docs.vapi.ai/api-reference/phone-numbers/update",
            dashboardUrl: "https://dashboard.vapi.ai/phone-numbers"
          }
        });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/vapi/create-assistant-from-template", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const templateId = safeString(body.templateId);
    const template = templateId ? await getTemplateById(templateId) : await getActiveTemplate();
    if (!template) {
      res.status(404).json({ ok: false, error: "Template not found" });
      return;
    }

    try {
      const created = await createVapiAssistantFromTemplate(template, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl),
        serverUrl: safeString(body.serverUrl),
        toolIds: toStringArray(body.toolIds),
        assistantName: safeString(body.assistantName)
      });

      res.json({
        ok: true,
        templateId: template.id,
        templateName: template.name,
        assistantId: created.id,
        assistantName: created.name
      });
    } catch (error) {
      if (error instanceof VapiAssistantError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/vapi/create-additional-agent", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const templateId = safeString(body.templateId);
    const phoneNumberId = safeString(body.phoneNumberId);
    if (!phoneNumberId) {
      res.status(400).json({ ok: false, error: "phoneNumberId is required for additional agent creation" });
      return;
    }

    const template = templateId ? await getTemplateById(templateId) : await getActiveTemplate();
    if (!template) {
      res.status(404).json({ ok: false, error: "Template not found" });
      return;
    }

    try {
      const created = await createVapiAssistantFromTemplate(template, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl),
        serverUrl: safeString(body.serverUrl),
        toolIds: toStringArray(body.toolIds),
        assistantName: safeString(body.assistantName)
      });

      const attached = await attachAssistantToVapiPhoneNumber(phoneNumberId, created.id, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl),
        serverUrl: safeString(body.serverUrl)
      });

      runtimeInfo("agent", "additional agent created and attached", {
        templateId: template.id,
        assistantId: created.id,
        phoneNumberId
      });

      res.json({
        ok: true,
        templateId: template.id,
        templateName: template.name,
        assistantId: created.id,
        assistantName: created.name,
        phoneNumberId,
        phoneNumber: attached
      });
    } catch (error) {
      if (error instanceof VapiAssistantError) {
        res.status(500).json({ ok: false, error: error.message, status: error.status, details: error.body });
        return;
      }
      if (error instanceof VapiPhoneNumberError) {
        res.status(500).json({
          ok: false,
          error: error.message,
          status: error.status,
          details: error.body,
          guide: {
            docsUrl: "https://docs.vapi.ai/api-reference/phone-numbers/update",
            dashboardUrl: "https://dashboard.vapi.ai/phone-numbers"
          }
        });
        return;
      }
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/calls", async (req: Request, res: Response) => {
    const statusFilter = safeString(req.query.status)?.toLowerCase();
    const outcomeFilter = safeString(req.query.outcome)?.toLowerCase();
    const q = safeString(req.query.q)?.toLowerCase();
    const limit = asOptionalInt(req.query.limit, 1, 1000) || 300;

    const calls = await withState((state) => {
      return Object.values(state.leads)
        .filter((lead) => Boolean(lead.callId || lead.callAttemptedAt || lead.outcome || lead.transcript || lead.recordingUrl))
        .filter((lead) => {
          if (statusFilter && (lead.status || "").toLowerCase() !== statusFilter) return false;
          if (outcomeFilter && (lead.outcome || "").toLowerCase() !== outcomeFilter) return false;
          if (!q) return true;
          const haystack = [lead.phone, lead.firstName, lead.lastName, lead.company, lead.email, lead.outcome]
            .map((v) => String(v || "").toLowerCase())
            .join(" ");
          return haystack.includes(q);
        })
        .sort((a, b) => {
          const aTs = Date.parse(a.updatedAt || a.callAttemptedAt || "");
          const bTs = Date.parse(b.updatedAt || b.callAttemptedAt || "");
          return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
        })
        .slice(0, limit)
        .map((lead) => ({
          id: lead.id,
          phone: lead.phone,
          firstName: lead.firstName,
          lastName: lead.lastName,
          company: lead.company,
          email: lead.email,
          status: lead.status,
          lastError: lead.lastError,
          attempts: lead.attempts,
          callId: lead.callId,
          callAttemptedAt: lead.callAttemptedAt,
          callEndedAt: lead.callEndedAt,
          outcome: lead.outcome,
          transcriptSummary: lead.transcriptSummary || (lead.transcript ? lead.transcript.slice(0, 220) : undefined),
          hasTranscript: Boolean(lead.transcript),
          hasAudio: Boolean(lead.recordingUrl),
          recordingUrl: lead.recordingUrl,
          bookingSource: lead.bookingSource,
          winSmsSentAt: lead.winSmsSentAt,
          winSmsError: lead.winSmsError,
          voicemailSmsSentAt: lead.voicemailSmsSentAt,
          voicemailSmsError: lead.voicemailSmsError,
          smsLastSid: lead.smsLastSid || extractSmsSidFromNotes(lead.notes),
          smsLastSentAt: lead.smsLastSentAt,
          smsLastType: lead.smsLastType,
          smsLastError: lead.smsLastError,
          updatedAt: lead.updatedAt
        }));
    });

    res.json({ ok: true, count: calls.length, calls });
  });

  app.get("/api/calls/:leadId", async (req: Request, res: Response) => {
    const lead = await findLeadByIdOrCallId(req.params.leadId);
    if (!lead) {
      res.status(404).json({ ok: false, error: "Lead not found" });
      return;
    }

    res.json({
      ok: true,
      call: {
        id: lead.id,
        phone: lead.phone,
        firstName: lead.firstName,
        lastName: lead.lastName,
        company: lead.company,
        email: lead.email,
        status: lead.status,
        lastError: lead.lastError,
        attempts: lead.attempts,
        callId: lead.callId,
        callAttemptedAt: lead.callAttemptedAt,
        callEndedAt: lead.callEndedAt,
        outcome: lead.outcome,
        transcript: lead.transcript,
        transcriptSummary: lead.transcriptSummary,
        recordingUrl: lead.recordingUrl,
        bookingSource: lead.bookingSource,
        winSmsSentAt: lead.winSmsSentAt,
        winSmsError: lead.winSmsError,
        voicemailSmsSentAt: lead.voicemailSmsSentAt,
        voicemailSmsError: lead.voicemailSmsError,
        smsLastSid: lead.smsLastSid || extractSmsSidFromNotes(lead.notes),
        smsLastSentAt: lead.smsLastSentAt,
        smsLastType: lead.smsLastType,
        smsLastError: lead.smsLastError,
        updatedAt: lead.updatedAt
      }
    });
  });

  const handleDirectVapiAudioDownload = async (
    req: Request,
    res: Response,
    forcedFormat?: AudioFormat
  ): Promise<void> => {
    const callId = safeString(req.params.callId);
    if (!callId) {
      res.status(400).json({ ok: false, error: "callId is required" });
      return;
    }

    const pulled = await fetchVapiArtifactsByCallId(callId);
    if (!pulled.ok || !pulled.artifacts) {
      res.status(pulled.statusCode || 502).json({
        ok: false,
        error: pulled.error || "Failed to fetch Vapi call artifacts",
        callId
      });
      return;
    }

    const requestedRaw = (forcedFormat || safeString(req.query.format)?.toLowerCase()) as string | undefined;
    const format: AudioFormat | undefined =
      requestedRaw === "mp3" || requestedRaw === "wav" ? requestedRaw : undefined;
    const url = await chooseAudioUrlFromSet(pulled.artifacts.audio, format);
    if (!url) {
      res.status(404).json({
        ok: false,
        error: "Audio recording URL not available for this call yet",
        callId,
        requestedFormat: format,
        available: pulled.artifacts.audio
      });
      return;
    }

    res.redirect(302, url);
  };

  app.get("/api/vapi/calls/:callId/artifacts", async (req: Request, res: Response) => {
    const callId = safeString(req.params.callId);
    if (!callId) {
      res.status(400).json({ ok: false, error: "callId is required" });
      return;
    }

    const pulled = await fetchVapiArtifactsByCallId(callId);
    if (!pulled.ok || !pulled.artifacts) {
      res.status(pulled.statusCode || 502).json({
        ok: false,
        error: pulled.error || "Failed to fetch Vapi call artifacts",
        callId
      });
      return;
    }

    const callIdEncoded = encodeURIComponent(callId);
    res.json({
      ok: true,
      callId,
      statusCode: pulled.statusCode,
      artifacts: pulled.artifacts,
      links: {
        transcript: `/api/vapi/calls/${callIdEncoded}/transcript.txt`,
        audio: `/api/vapi/calls/${callIdEncoded}/audio`,
        mp3: `/api/vapi/calls/${callIdEncoded}/audio.mp3`,
        wav: `/api/vapi/calls/${callIdEncoded}/audio.wav`
      },
      raw: pulled.raw
    });
  });

  app.get("/api/vapi/calls/:callId/transcript.txt", async (req: Request, res: Response) => {
    const callId = safeString(req.params.callId);
    if (!callId) {
      res.status(400).json({ ok: false, error: "callId is required" });
      return;
    }

    const pulled = await fetchVapiArtifactsByCallId(callId);
    if (!pulled.ok || !pulled.artifacts) {
      res.status(pulled.statusCode || 502).json({
        ok: false,
        error: pulled.error || "Failed to fetch Vapi call artifacts",
        callId
      });
      return;
    }
    if (!pulled.artifacts.transcript) {
      res.status(404).json({
        ok: false,
        error: "Transcript not available for this call yet",
        callId
      });
      return;
    }

    const fileName = `${callId}-transcript.txt`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
    res.send(pulled.artifacts.transcript);
  });

  app.get("/api/vapi/calls/:callId/audio", async (req: Request, res: Response) => {
    await handleDirectVapiAudioDownload(req, res);
  });

  app.get("/api/vapi/calls/:callId/audio.mp3", async (req: Request, res: Response) => {
    await handleDirectVapiAudioDownload(req, res, "mp3");
  });

  app.get("/api/vapi/calls/:callId/audio.wav", async (req: Request, res: Response) => {
    await handleDirectVapiAudioDownload(req, res, "wav");
  });

  app.post("/api/calls/:leadId/pull-artifacts", async (req: Request, res: Response) => {
    const lookupId = safeString(req.params.leadId) || "";
    const lead = await findLeadByIdOrCallId(lookupId);
    if (!lead) {
      const direct = await fetchVapiArtifactsByCallId(lookupId);
      if (!direct.ok || !direct.artifacts) {
        res.status(direct.statusCode || 404).json({
          ok: false,
          error: direct.error || "Lead not found and Vapi call lookup failed",
          callId: lookupId
        });
        return;
      }

      runtimeInfo("vapi", "manual artifact pull completed (direct call lookup)", {
        leadId: "",
        callId: lookupId,
        fetched: true,
        updated: false,
        hasTranscript: Boolean(direct.artifacts.transcript),
        audioCount: direct.artifacts.audio.any.length,
        statusCode: direct.statusCode
      });

      const callIdEncoded = encodeURIComponent(lookupId);
      res.json({
        ok: true,
        leadId: undefined,
        callId: lookupId,
        fetchedFromVapi: true,
        updatedLead: false,
        statusCode: direct.statusCode,
        hasTranscript: Boolean(direct.artifacts.transcript),
        hasAudio: Boolean(direct.artifacts.audio.any.length > 0),
        audio: {
          available: direct.artifacts.audio,
          recordingUrl: direct.artifacts.audio.any[0]
        },
        links: {
          transcript: `/api/vapi/calls/${callIdEncoded}/transcript.txt`,
          audio: `/api/vapi/calls/${callIdEncoded}/audio`,
          mp3: `/api/vapi/calls/${callIdEncoded}/audio.mp3`,
          wav: `/api/vapi/calls/${callIdEncoded}/audio.wav`,
          trace: `/api/vapi/calls/${callIdEncoded}/artifacts`,
          vapiReport: `/api/vapi/calls/${callIdEncoded}/artifacts`
        }
      });
      return;
    }

    const pulled = await refreshLeadArtifactsFromVapi(lead);
    const routeId = encodeURIComponent(pulled.lead.id);
    runtimeInfo("vapi", "manual artifact pull completed", {
      leadId: pulled.lead.id,
      callId: pulled.lead.callId,
      fetched: pulled.fetched,
      updated: pulled.updated,
      hasTranscript: Boolean(pulled.lead.transcript),
      audioCount: pulled.artifacts.audio.any.length,
      statusCode: pulled.statusCode,
      error: pulled.error
    });

    res.json({
      ok: true,
      leadId: pulled.lead.id,
      callId: pulled.lead.callId,
      fetchedFromVapi: pulled.fetched,
      updatedLead: pulled.updated,
      statusCode: pulled.statusCode,
      error: pulled.error,
      hasTranscript: Boolean(pulled.lead.transcript),
      hasAudio: Boolean(pulled.artifacts.audio.any.length > 0),
      audio: {
        available: pulled.artifacts.audio,
        recordingUrl: pulled.lead.recordingUrl
      },
      links: {
        transcript: `/api/calls/${routeId}/transcript.txt?refresh=1`,
        audio: `/api/calls/${routeId}/audio?refresh=1`,
        mp3: `/api/calls/${routeId}/audio.mp3?refresh=1`,
        wav: `/api/calls/${routeId}/audio.wav?refresh=1`,
        trace: `/api/calls/${routeId}/trace`,
        vapiReport: `/api/calls/${routeId}/vapi-report`
      }
    });
  });

  app.get("/api/calls/:leadId/transcript.txt", async (req: Request, res: Response) => {
    let lead = await findLeadByIdOrCallId(req.params.leadId);
    if (!lead) {
      res.status(404).json({ ok: false, error: "Lead not found" });
      return;
    }
    const shouldRefresh = asBool(req.query.refresh, false) || !lead.transcript;
    if (shouldRefresh && lead.callId) {
      const pulled = await refreshLeadArtifactsFromVapi(lead);
      lead = pulled.lead;
    }
    if (!lead.transcript) {
      res.status(404).json({ ok: false, error: "Transcript not available for this call yet" });
      return;
    }

    const namePart = [lead.firstName, lead.lastName].filter(Boolean).join("-").toLowerCase() || "lead";
    const phonePart = (lead.phone || "unknown").replace(/[^+\d]/g, "");
    const fileName = `${namePart}-${phonePart}-transcript.txt`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
    res.send(lead.transcript);
  });

  const handleAudioDownload = async (req: Request, res: Response, forcedFormat?: AudioFormat): Promise<void> => {
    const lead = await findLeadByIdOrCallId(req.params.leadId);
    if (!lead) {
      res.status(404).json({ ok: false, error: "Lead not found" });
      return;
    }

    const requestedRaw = (forcedFormat || safeString(req.query.format)?.toLowerCase()) as string | undefined;
    const format: AudioFormat | undefined =
      requestedRaw === "mp3" || requestedRaw === "wav" ? requestedRaw : undefined;
    const shouldRefresh = asBool(req.query.refresh, false) || !lead.recordingUrl;
    const resolved = await resolveAudioDownloadUrl(lead, format, shouldRefresh);

    if (!resolved.url) {
      const status = resolved.statusCode && resolved.statusCode >= 400 && resolved.statusCode < 600 ? resolved.statusCode : 404;
      res.status(status).json({
        ok: false,
        error: resolved.error || "Audio recording URL not available for this call yet",
        requestedFormat: format,
        available: resolved.audio,
        leadId: lead.id,
        callId: lead.callId
      });
      return;
    }

    res.redirect(302, resolved.url);
  };

  app.get("/api/calls/:leadId/audio", async (req: Request, res: Response) => {
    await handleAudioDownload(req, res);
  });

  app.get("/api/calls/:leadId/audio.mp3", async (req: Request, res: Response) => {
    await handleAudioDownload(req, res, "mp3");
  });

  app.get("/api/calls/:leadId/audio.wav", async (req: Request, res: Response) => {
    await handleAudioDownload(req, res, "wav");
  });

  app.get("/api/calls/:leadId/vapi-report", async (req: Request, res: Response) => {
    const lead = await findLeadByIdOrCallId(req.params.leadId);
    if (!lead) {
      res.status(404).json({ ok: false, error: "Lead not found" });
      return;
    }
    if (!lead.callId) {
      res.status(400).json({ ok: false, error: "Lead does not have a callId yet" });
      return;
    }

    const remote = await fetchVapiCallById(lead.callId);
    if (!remote.ok || !remote.data) {
      const status = remote.status >= 400 && remote.status < 600 ? remote.status : 502;
      res.status(status).json({
        ok: false,
        error: remote.error || "Failed to fetch Vapi call report",
        leadId: lead.id,
        callId: lead.callId
      });
      return;
    }

    const root = remote.data;
    const callNode = asObject(root.call) || root;
    const analysis = asObject(callNode.analysis) || asObject(root.analysis) || {};
    const artifact = asObject(callNode.artifact) || asObject(root.artifact) || {};
    const artifactMessages = Array.isArray(artifact.messages) ? artifact.messages : [];
    const firstArtifactMessage = asObject(artifactMessages[0]) || {};
    const transcript =
      safeString(artifact.transcript) ||
      safeString(firstArtifactMessage.transcript) ||
      safeString(firstArtifactMessage.content);

    res.json({
      ok: true,
      leadId: lead.id,
      callId: lead.callId,
      report: {
        status: safeString(callNode.status) || safeString(root.status),
        startedAt: safeString(callNode.startedAt) || safeString(root.startedAt),
        endedAt: safeString(callNode.endedAt) || safeString(root.endedAt),
        endedReason:
          safeString(callNode.endedReason) ||
          safeString(analysis.endedReason) ||
          safeString((asObject(analysis.summary) || {}).endedReason),
        durationSeconds:
          Number(callNode.durationSeconds || root.durationSeconds || 0) ||
          Number((asObject(analysis.costBreakdown) || {}).durationSeconds || 0),
        transcriptSummary: transcript ? transcript.slice(0, 400) : undefined
      },
      raw: root
    });
  });

  app.get("/api/calls/:leadId/twilio-sms", async (req: Request, res: Response) => {
    const lead = await findLeadByIdOrCallId(req.params.leadId);
    if (!lead) {
      res.status(404).json({ ok: false, error: "Lead not found" });
      return;
    }
    if (!isTwilioSmsConfigured()) {
      res.status(400).json({ ok: false, error: "Twilio SMS is not configured" });
      return;
    }

    const limit = asOptionalInt(req.query.limit, 1, 100) || 20;
    const sid = lead.smsLastSid || extractSmsSidFromNotes(lead.notes);

    try {
      const recent = await listTwilioMessages({ to: lead.phone, pageSize: limit });
      let sidRecord: Record<string, unknown> | undefined;
      if (sid) {
        try {
          const direct = await fetchTwilioMessageBySid(sid);
          sidRecord = direct as unknown as Record<string, unknown>;
        } catch (error) {
          sidRecord = {
            sid,
            lookupError: String(error).slice(0, 300)
          };
        }
      }

      res.json({
        ok: true,
        leadId: lead.id,
        phone: lead.phone,
        sms: {
          lastSid: sid,
          lastSentAt: lead.smsLastSentAt,
          lastType: lead.smsLastType,
          lastError: lead.smsLastError || lead.winSmsError || lead.voicemailSmsError,
          sidRecord,
          recent
        }
      });
    } catch (error) {
      res.status(502).json({
        ok: false,
        error: String(error).slice(0, 400),
        leadId: lead.id
      });
    }
  });

  app.get("/api/calls/:leadId/trace", async (req: Request, res: Response) => {
    const lead = await findLeadByIdOrCallId(req.params.leadId);
    if (!lead) {
      res.status(404).json({ ok: false, error: "Lead not found" });
      return;
    }

    const includeVapi = asOptionalBool(req.query.includeVapi);
    const includeTwilio = asOptionalBool(req.query.includeTwilio);
    const logLimit = asOptionalInt(req.query.logLimit, 10, 500) || 150;
    const smsSid = lead.smsLastSid || extractSmsSidFromNotes(lead.notes);
    const shouldIncludeVapi = includeVapi === undefined ? true : includeVapi;
    const shouldIncludeTwilio = includeTwilio === undefined ? true : includeTwilio;

    let vapiTrace: Record<string, unknown> = {
      enabled: shouldIncludeVapi,
      configured: Boolean(config.vapiApiKey),
      callId: lead.callId
    };
    if (shouldIncludeVapi && lead.callId) {
      const remote = await fetchVapiCallById(lead.callId);
      vapiTrace = {
        ...vapiTrace,
        fetched: remote.ok,
        statusCode: remote.status,
        error: remote.ok ? undefined : remote.error,
        raw: remote.ok ? remote.data : undefined
      };
    }

    let twilioTrace: Record<string, unknown> = {
      enabled: shouldIncludeTwilio,
      configured: isTwilioSmsConfigured(),
      lastSid: smsSid
    };
    if (shouldIncludeTwilio && isTwilioSmsConfigured()) {
      try {
        const recent = await listTwilioMessages({ to: lead.phone, pageSize: 25 });
        let sidRecord: Record<string, unknown> | undefined;
        if (smsSid) {
          try {
            sidRecord = (await fetchTwilioMessageBySid(smsSid)) as unknown as Record<string, unknown>;
          } catch (error) {
            sidRecord = {
              sid: smsSid,
              lookupError: String(error).slice(0, 300)
            };
          }
        }
        twilioTrace = {
          ...twilioTrace,
          fetched: true,
          recent,
          sidRecord
        };
      } catch (error) {
        twilioTrace = {
          ...twilioTrace,
          fetched: false,
          error: String(error).slice(0, 400)
        };
      }
    }

    const phoneDigits = (lead.phone || "").replace(/\D/g, "");
    const tokens = [
      (lead.id || "").toLowerCase(),
      (lead.callId || "").toLowerCase(),
      (lead.phone || "").toLowerCase(),
      phoneDigits,
      (smsSid || "").toLowerCase()
    ].filter(Boolean);

    const relatedLogs = listRuntimeLogs({ limit: 1000 })
      .filter((entry) => {
        const message = String(entry.message || "").toLowerCase();
        return tokens.some((token) => message.includes(token));
      })
      .slice(-logLimit);

    res.json({
      ok: true,
      trace: {
        lead: {
          id: lead.id,
          phone: lead.phone,
          status: lead.status,
          attempts: lead.attempts,
          lastError: lead.lastError,
          callId: lead.callId,
          callAttemptedAt: lead.callAttemptedAt,
          callEndedAt: lead.callEndedAt,
          outcome: lead.outcome,
          hasTranscript: Boolean(lead.transcript),
          transcriptSummary: lead.transcriptSummary || (lead.transcript ? lead.transcript.slice(0, 350) : undefined),
          recordingUrl: lead.recordingUrl,
          smsLastSid: smsSid,
          smsLastSentAt: lead.smsLastSentAt,
          smsLastType: lead.smsLastType,
          smsLastError: lead.smsLastError || lead.winSmsError || lead.voicemailSmsError
        },
        vapi: vapiTrace,
        twilio: twilioTrace,
        relatedLogs
      }
    });
  });

  app.get("/api/leads", async (_req: Request, res: Response) => {
    const data = await withState((state) => {
      return Object.values(state.leads)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 200)
        .map((lead) => ({
          id: lead.id,
          phone: lead.phone,
          email: lead.email,
          company: lead.company,
          status: lead.status,
          attempts: lead.attempts,
          callId: lead.callId,
          callAttemptedAt: lead.callAttemptedAt,
          callEndedAt: lead.callEndedAt,
          outcome: lead.outcome,
          transcriptSummary: lead.transcriptSummary || (lead.transcript ? lead.transcript.slice(0, 220) : undefined),
          hasTranscript: Boolean(lead.transcript),
          hasAudio: Boolean(lead.recordingUrl),
          recordingUrl: lead.recordingUrl,
          retargetBucket: lead.retargetBucket,
          retargetReason: lead.retargetReason,
          bookingSource: lead.bookingSource,
          winSmsSentAt: lead.winSmsSentAt,
          winSmsError: lead.winSmsError,
          voicemailSmsSentAt: lead.voicemailSmsSentAt,
          voicemailSmsError: lead.voicemailSmsError,
          smsLastSid: lead.smsLastSid || extractSmsSidFromNotes(lead.notes),
          smsLastSentAt: lead.smsLastSentAt,
          smsLastType: lead.smsLastType,
          smsLastError: lead.smsLastError,
          ghlContactId: lead.ghlContactId,
          updatedAt: lead.updatedAt
        }));
    });

    res.json({ ok: true, leads: data });
  });

  app.post("/api/manual-call/generate", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const brandName = safeString(body.brandName) || "True Rank Digital";
    const customMessage = safeString(body.customMessage);
    if (!customMessage) {
      res.status(400).json({ ok: false, error: "customMessage is required" });
      return;
    }

    try {
      const generated = await generateManualCallDraft({
        brandName,
        firstName: safeString(body.firstName),
        businessName: safeString(body.businessName),
        customMessage
      });

      res.json({
        ok: true,
        generated,
        geminiConfigured: isGeminiConfigured()
      });
    } catch (error) {
      runtimeError("agent", "manual call prompt generation failed", error);
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/manual-call", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const rawToNumber = safeString(body.toNumber) || "";
    const toNumber = normalizePhone(rawToNumber);
    if (!toNumber) {
      res.status(400).json({ ok: false, error: "Invalid toNumber. Provide a valid E.164 or US number." });
      return;
    }

    const customMessage = safeString(body.customMessage);
    if (!customMessage) {
      res.status(400).json({ ok: false, error: "customMessage is required" });
      return;
    }

    const brandName = safeString(body.brandName) || "True Rank Digital";
    const templateId = safeString(body.templateId);
    const selectedTemplate = templateId ? await getTemplateById(templateId) : await getActiveTemplate();
    const voiceRaw = safeString(body.voiceProfile)?.toLowerCase() || "";
    const voiceProfile: VoiceProfile =
      voiceRaw === "male" || voiceRaw === "female" ? voiceRaw : voiceFromTemplate(selectedTemplate);
    const firstName = safeString(body.firstName);
    const businessName = safeString(body.businessName);
    const customVariables = toStringRecord(body.customVariables);
    const generateOnly = asBool(body.generateOnly, false);

    const generated = await generateManualCallDraft({
      brandName,
      firstName,
      businessName,
      customMessage
    });

    if (generateOnly) {
      res.json({
        ok: true,
        generateOnly: true,
        generated
      });
      return;
    }

    const lead = leadFromTestPayload(
      {
        ...body,
        firstName,
        company: businessName,
        findings: customMessage,
        notes: `Manual dashboard call: ${customMessage}`
      },
      toNumber,
      selectedTemplate
    );

    lead.company = businessName || lead.company;
    lead.findings = customMessage;
    lead.notes = `Manual dashboard call. Topic=${customMessage}. PromptProvider=${generated.provider}`;
    lead.sourceFile = "manual-dashboard";
    lead.campaign = `${brandName} Manual Outreach (${voiceProfile})`;
    // Pre-lock manual call leads so the background dialer cannot race and place a duplicate call.
    const manualAttemptAt = nowIso();
    lead.status = "dialing";
    lead.attempts = 1;
    lead.callAttemptedAt = manualAttemptAt;
    lead.lastAttemptAt = manualAttemptAt;
    lead.callId = undefined;
    lead.lastError = undefined;
    lead.outcome = undefined;
    lead.retargetBucket = undefined;
    lead.retargetReason = undefined;
    lead.retargetReadyAt = undefined;
    lead.bookingSource = undefined;
    lead.bookedAt = undefined;
    lead.recordingUrl = undefined;
    lead.transcript = undefined;
    lead.transcriptSummary = undefined;
    lead.updatedAt = nowIso();

    await upsertManualLead(lead);

    try {
      const result = await createOutboundCall(lead, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl),
        assistantId: safeString(body.assistantId),
        phoneNumberId: safeString(body.phoneNumberId),
        twilioAccountSid: safeString(body.twilioAccountSid),
        twilioAuthToken: safeString(body.twilioAuthToken),
        twilioPhoneNumber: safeString(body.twilioPhoneNumber),
        voiceProfile,
        additionalVariables: {
          brandName,
          leadCompany: businessName || "",
          leadFindings: customMessage,
          agentTemplateName: selectedTemplate?.name || "Manual Prompt",
          agentTemplateRules: generated.draft.assistantPrompt,
          agentObjective: customMessage,
          agentOfferSummary:
            "Free strategy meeting to expose where revenue is being lost due to weak AI and Google visibility.",
          manualFirstMessage: generated.draft.firstMessage,
          manualObjectionHandling: generated.draft.objectionHandling.join(" | "),
          manualSmsSummary: generated.draft.smsSummary,
          ...customVariables
        }
      });

      await markManualLeadCallCreated(lead.id, result.id);
      runtimeInfo("agent", "manual call queued with generated prompt", {
        leadId: lead.id,
        callId: result.id,
        toNumber,
        provider: generated.provider,
        model: generated.model || ""
      });

      res.json({
        ok: true,
        leadId: lead.id,
        callId: result.id,
        generated,
        customVariablesApplied: Object.keys(customVariables).length
      });
    } catch (error) {
      await patchLead(lead.id, {
        status: "failed",
        attempts: 1,
        lastError: String(error).slice(0, 600),
        callAttemptedAt: nowIso(),
        callEndedAt: nowIso(),
        outcome: "call_create_failed"
      });
      runtimeError("agent", "manual call failed", error, {
        leadId: lead.id,
        toNumber
      });
      res.status(500).json({ ok: false, error: String(error), generated });
    }
  });

  app.post("/api/prospector/test-contact", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const leadId = safeString(body.leadId);
    const rawToNumber = safeString(body.toNumber) || "";
    const toNumber = normalizePhone(rawToNumber);
    const sendSms = asBool(body.sendSms, true);

    if (!leadId) {
      res.status(400).json({ ok: false, error: "leadId is required" });
      return;
    }
    if (!toNumber) {
      res.status(400).json({ ok: false, error: "Invalid toNumber" });
      return;
    }

    const sourceLead = await getProspectLeadById(leadId);
    if (!sourceLead) {
      res.status(404).json({ ok: false, error: "Prospect lead not found" });
      return;
    }
    if (!sourceLead.generatedSitePath || !sourceLead.generatedScreenshotPath) {
      res.status(400).json({ ok: false, error: "Prospect assets are not ready" });
      return;
    }

    const lead: Lead = {
      ...sourceLead,
      id: `${sourceLead.id}-test-call`,
      phone: toNumber,
      status: 'queued',
      attempts: 0,
      callId: undefined,
      callAttemptedAt: undefined,
      callEndedAt: undefined,
      lastAttemptAt: undefined,
      lastError: undefined,
      outcome: undefined,
      transcript: undefined,
      transcriptSummary: undefined,
      recordingUrl: undefined,
      sourceFile: 'prospector-test-call',
      notes: `Prospector test call to owner-approved number using lead ${sourceLead.id}`,
      updatedAt: nowIso(),
      createdAt: nowIso()
    };

    try {
      const liveLink = sourceLead.deployedSiteUrl || sourceLead.generatedSitePath || '';
      const twilioPayload = {
        assistantId: config.vapiAssistantId,
        customer: {
          number: toNumber,
          name: String(sourceLead.company || 'Test Prospect').slice(0, 40)
        },
        phoneNumber: {
          twilioPhoneNumber: config.twilioPhoneNumber,
          twilioAccountSid: config.twilioAccountSid,
          twilioAuthToken: config.twilioAuthToken
        },
        assistantOverrides: {
          variableValues: {
            leadCompany: sourceLead.company || '',
            leadFindings: sourceLead.findings || '',
            deployedSiteUrl: liveLink,
            generatedScreenshotPath: sourceLead.generatedScreenshotPath || '',
            demoOffer: 'We created a quick vision of what we can do on the fly and will text over the live link after the call.',
            complianceNote: 'It is just a vision of what we can do on the fly.'
          }
        },
        metadata: {
          leadId: lead.id,
          campaign: lead.campaign,
          sourceFile: lead.sourceFile
        }
      };

      const vapiResponse = await fetch(`${config.vapiBaseUrl}/call`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.vapiApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(twilioPayload)
      });
      const raw = await vapiResponse.text();
      if (!vapiResponse.ok) {
        throw new Error(`Vapi prospect test call failed (${vapiResponse.status}): ${raw}`);
      }
      const result = JSON.parse(raw) as { id: string };

      let sms: Record<string, unknown> | undefined;
      if (sendSms) {
        const bookingLink = resolvedBookingUrl();
        const text = `${sourceLead.company || 'Your business'}: we put together a quick vision of what we can do on the fly. Live preview: ${liveLink}${bookingLink ? ` | Book here: ${bookingLink}` : ''}`;
        const sent = await sendSmsMessage({ to: toNumber, body: text });
        sms = { sent: true, sid: sent.sid, status: sent.status };
      }

      res.json({ ok: true, callId: result.id, leadId: lead.id, sms });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/test-call", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const rawToNumber = safeString(body.toNumber) || "";
    const toNumber = normalizePhone(rawToNumber);
    if (!toNumber) {
      res.status(400).json({ ok: false, error: "Invalid toNumber. Provide a valid E.164 or US number." });
      return;
    }

    const templateId = safeString(body.templateId);
    const selectedTemplate = templateId ? await getTemplateById(templateId) : await getActiveTemplate();
    const voiceRaw = safeString(body.voiceProfile)?.toLowerCase() || "";
    const voiceProfile: VoiceProfile =
      voiceRaw === "male" || voiceRaw === "female" ? voiceRaw : voiceFromTemplate(selectedTemplate);
    const lead = leadFromTestPayload(body, toNumber, selectedTemplate);
    const compiledTemplate = selectedTemplate ? compileTemplatePrompt(selectedTemplate) : undefined;
    const customVariables = toStringRecord(body.customVariables);
    const manualVariableOverrides: Record<string, string> = {
      ...customVariables
    };
    const bookingUrlOverride = safeString(body.bookingUrl);
    const calendlyUrlOverride = safeString(body.calendlyUrl);
    const googleCalendarUrlOverride = safeString(body.googleCalendarUrl);
    if (bookingUrlOverride) manualVariableOverrides.bookingUrl = bookingUrlOverride;
    if (calendlyUrlOverride) manualVariableOverrides.calendlyUrl = calendlyUrlOverride;
    if (googleCalendarUrlOverride) manualVariableOverrides.googleCalendarUrl = googleCalendarUrlOverride;

    try {
      const result = await createOutboundCall(lead, {
        apiKey: safeString(body.vapiApiKey),
        baseUrl: safeString(body.vapiBaseUrl),
        assistantId: safeString(body.assistantId),
        phoneNumberId: safeString(body.phoneNumberId),
        twilioAccountSid: safeString(body.twilioAccountSid),
        twilioAuthToken: safeString(body.twilioAuthToken),
        twilioPhoneNumber: safeString(body.twilioPhoneNumber),
        voiceProfile,
        additionalVariables: {
          agentTemplateName: selectedTemplate?.name || "",
          agentTemplateRules: compiledTemplate?.prompt || "",
          agentObjective: selectedTemplate?.objective || "",
          agentCta: selectedTemplate?.cta || "",
          agentOfferSummary: selectedTemplate?.offerSummary || "",
          ...manualVariableOverrides
        }
      });

      res.json({
        ok: true,
        callId: result.id,
        leadId: lead.id,
        templateId: selectedTemplate?.id,
        templateQualityScore: compiledTemplate?.quality.score,
        customVariablesApplied: Object.keys(customVariables).length
      });
      runtimeInfo("agent", "manual test call queued", {
        leadId: lead.id,
        callId: result.id,
        toNumber,
        templateId: selectedTemplate?.id || "",
        customVariables: Object.keys(customVariables).length
      });
    } catch (error) {
      runtimeError("agent", "manual test call failed", error, {
        toNumber,
        templateId: selectedTemplate?.id || ""
      });
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/webhooks/vapi", async (req: Request, res: Response) => {
    if (!verifySecret(req)) {
      res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      return;
    }

    const payload = (req.body || {}) as Record<string, unknown>;
    const callId = getCallId(payload);
    const eventType = getEventType(payload);
    runtimeInfo("webhook", `vapi event=${eventType}`, { callId: callId || "" });

    if (callId && isTerminalEvent(payload)) {
      runtimeInfo("webhook", "terminal event received; finalizing call", { callId });
      await finalizeCall(callId, payload);
    }

    res.json({ ok: true });
  });

  app.post("/webhooks/meeting-booked", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const lead = await findLeadByIdentity({
      leadId: safeString(body.leadId),
      phone: safeString(body.phone),
      email: safeString(body.email)
    });

    if (!lead) {
      res.status(404).json({ ok: false, error: "Lead not found" });
      return;
    }

    const source = safeString(body.source) || "manual-webhook";
    const updated = await markLeadBooked(lead, source);
    if (updated) {
      await syncLeadAfterAttempt(updated, {
        outcome: "booked",
        transcript: updated.transcript,
        bookingSource: source,
        force: true
      });
      await maybeSendWinSms(updated, "booked");
    }

    res.json({ ok: true, leadId: lead.id });
  });

  app.post("/webhooks/calendly", async (req: Request, res: Response) => {
    const rawReq = req as RawBodyRequest;
    if (!verifyCalendlyWebhook(rawReq)) {
      res.status(401).json({ ok: false, error: "Invalid Calendly signature" });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const event = safeString(body.event)?.toLowerCase() || "";
    if (event !== "invitee.created") {
      res.json({ ok: true, ignored: true });
      return;
    }

    const payload = asObject(body.payload) || {};
    const invitee = asObject(payload.invitee) || {};
    const email = safeString(payload.email) || safeString(invitee.email);
    const phone = extractPhoneFromCalendlyPayload(payload);

    const lead = await findLeadByIdentity({ email, phone });
    if (!lead) {
      res.status(404).json({ ok: false, error: "No lead matched Calendly booking" });
      return;
    }

    const updated = await markLeadBooked(lead, "calendly");
    if (updated) {
      await syncLeadAfterAttempt(updated, {
        outcome: "booked",
        transcript: updated.transcript,
        bookingSource: "calendly",
        force: true
      });
      await maybeSendWinSms(updated, "booked");
    }

    res.json({ ok: true, leadId: lead.id });
  });

  app.post("/webhooks/google-calendar", async (req: Request, res: Response) => {
    if (!verifyGoogleCalendarWebhook(req)) {
      res.status(401).json({ ok: false, error: "Invalid Google Calendar webhook secret" });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const lead = await findLeadByIdentity({
      leadId: safeString(body.leadId),
      phone: safeString(body.phone),
      email: safeString(body.email)
    });

    if (!lead) {
      res.status(404).json({ ok: false, error: "No lead matched Google Calendar booking" });
      return;
    }

    const updated = await markLeadBooked(lead, "google-calendar");
    if (updated) {
      await syncLeadAfterAttempt(updated, {
        outcome: "booked",
        transcript: updated.transcript,
        bookingSource: "google-calendar",
        force: true
      });
      await maybeSendWinSms(updated, "booked");
    }

    res.json({ ok: true, leadId: lead.id });
  });

  startReconcileLoop();
  return app;
}

async function main(): Promise<void> {
  const app = createServer();
  app.listen(config.port, () => {
    runtimeInfo("server", `Listening on :${config.port}`);
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
