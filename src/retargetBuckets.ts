import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { Lead } from "./types.js";
import { nowIso } from "./utils.js";

const NO_CONTACT_OUTCOMES = new Set(["no_answer", "voicemail"]);
const RETARGET_BUCKETS = new Map<string, "no-answer" | "voicemail" | "answered-hung-up">([
  ["no_answer", "no-answer"],
  ["voicemail", "voicemail"],
  ["answered_hung_up", "answered-hung-up"]
]);
const RETARGET_HEADERS = [
  "lead_id",
  "phone",
  "first_name",
  "last_name",
  "email",
  "company",
  "timezone",
  "campaign",
  "source_file",
  "source_row",
  "outcome",
  "attempts",
  "last_attempt_at",
  "call_id",
  "retarget_bucket",
  "retarget_reason",
  "retarget_ready_at",
  "suggested_agent_variant",
  "opt_in",
  "dnc",
  "findings",
  "notes"
] as const;

type RetargetBucketName = "no-answer" | "voicemail" | "answered-hung-up" | "no-contact";

export interface RetargetBucketSummary {
  totalLeads: number;
  noAnswer: number;
  voicemail: number;
  answeredHungUp: number;
  noContact: number;
}

export interface RetargetBucketFile {
  bucket: RetargetBucketName;
  count: number;
  path: string;
  snapshot: boolean;
}

export interface RetargetExportResult {
  generatedAt: string;
  summary: RetargetBucketSummary;
  files: RetargetBucketFile[];
}

export interface RetargetExportOptions {
  writeLatest?: boolean;
  writeSnapshot?: boolean;
  label?: string;
}

function normalizeOutcome(outcome?: string): string {
  if (!outcome) return "";
  const base = outcome.split(";")[0] || "";
  return base.trim().toLowerCase().replace(/\s+/g, "_");
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const raw = String(value);
  if (!/[,"\n\r]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, "\"\"")}"`;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  const header = RETARGET_HEADERS.join(",");
  const body = rows.map((row) => RETARGET_HEADERS.map((key) => csvCell(row[key])).join(",")).join("\n");
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

function toRunStamp(label?: string): string {
  const now = nowIso().replace(/[:.]/g, "-");
  if (!label) return now;
  const suffix = label.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return suffix ? `${now}-${suffix}` : now;
}

function suggestedAgentVariant(lead: Lead): string {
  if (config.vapiAssistantIdFemale && config.vapiAssistantIdMale) {
    return lead.attempts % 2 === 0 ? "female" : "male";
  }
  if (config.vapiAssistantIdMale) return "male";
  if (config.vapiAssistantIdFemale) return "female";
  return "default";
}

function toRetargetRow(lead: Lead, bucket: string): Record<string, unknown> {
  return {
    lead_id: lead.id,
    phone: lead.phone,
    first_name: lead.firstName || "",
    last_name: lead.lastName || "",
    email: lead.email || "",
    company: lead.company || "",
    timezone: lead.timezone,
    campaign: lead.campaign,
    source_file: lead.sourceFile,
    source_row: lead.sourceRow,
    outcome: lead.outcome || "",
    attempts: lead.attempts,
    last_attempt_at: lead.lastAttemptAt || lead.callAttemptedAt || "",
    call_id: lead.callId || "",
    retarget_bucket: bucket,
    retarget_reason: lead.retargetReason || normalizeOutcome(lead.outcome),
    retarget_ready_at: lead.retargetReadyAt || lead.updatedAt,
    suggested_agent_variant: suggestedAgentVariant(lead),
    opt_in: lead.optIn ? "true" : "false",
    dnc: lead.dnc ? "true" : "false",
    findings: lead.findings || "",
    notes: lead.notes || ""
  };
}

export function retargetBucketFromOutcome(outcome?: string): "no-answer" | "voicemail" | "answered-hung-up" | undefined {
  return RETARGET_BUCKETS.get(normalizeOutcome(outcome));
}

function bucketRows(leads: Lead[]): {
  noAnswerRows: Array<Record<string, unknown>>;
  voicemailRows: Array<Record<string, unknown>>;
  answeredHungUpRows: Array<Record<string, unknown>>;
} {
  const sorted = [...leads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const noAnswerRows: Array<Record<string, unknown>> = [];
  const voicemailRows: Array<Record<string, unknown>> = [];
  const answeredHungUpRows: Array<Record<string, unknown>> = [];

  for (const lead of sorted) {
    const bucket = retargetBucketFromOutcome(lead.outcome);
    if (bucket === "no-answer") {
      noAnswerRows.push(toRetargetRow(lead, "no-answer"));
    } else if (bucket === "voicemail") {
      voicemailRows.push(toRetargetRow(lead, "voicemail"));
    } else if (bucket === "answered-hung-up") {
      answeredHungUpRows.push(toRetargetRow(lead, "answered-hung-up"));
    }
  }

  return { noAnswerRows, voicemailRows, answeredHungUpRows };
}

export function noContactFromOutcome(outcome?: string): boolean {
  return NO_CONTACT_OUTCOMES.has(normalizeOutcome(outcome));
}

export function summarizeRetargetBuckets(leads: Lead[]): RetargetBucketSummary {
  const { noAnswerRows, voicemailRows, answeredHungUpRows } = bucketRows(leads);
  return {
    totalLeads: leads.length,
    noAnswer: noAnswerRows.length,
    voicemail: voicemailRows.length,
    answeredHungUp: answeredHungUpRows.length,
    noContact: noAnswerRows.length + voicemailRows.length
  };
}

async function writeBucketFiles(
  directory: string,
  rows: {
    noAnswerRows: Array<Record<string, unknown>>;
    voicemailRows: Array<Record<string, unknown>>;
    answeredHungUpRows: Array<Record<string, unknown>>;
  },
  snapshot: boolean
): Promise<RetargetBucketFile[]> {
  await fs.mkdir(directory, { recursive: true });

  const noContactRows = [...rows.noAnswerRows, ...rows.voicemailRows];
  const files: Array<{ bucket: RetargetBucketName; name: string; rows: Array<Record<string, unknown>> }> = [
    { bucket: "no-answer", name: "no-answer.csv", rows: rows.noAnswerRows },
    { bucket: "voicemail", name: "voicemail.csv", rows: rows.voicemailRows },
    { bucket: "answered-hung-up", name: "answered-hung-up.csv", rows: rows.answeredHungUpRows },
    { bucket: "no-contact", name: "no-contact.csv", rows: noContactRows }
  ];

  const out: RetargetBucketFile[] = [];
  for (const file of files) {
    const target = path.resolve(directory, file.name);
    await fs.writeFile(target, toCsv(file.rows), "utf8");
    out.push({ bucket: file.bucket, count: file.rows.length, path: target, snapshot });
  }

  return out;
}

export async function exportRetargetBuckets(leads: Lead[], options?: RetargetExportOptions): Promise<RetargetExportResult> {
  const writeLatest = options?.writeLatest !== false;
  const writeSnapshot = Boolean(options?.writeSnapshot);
  const generatedAt = nowIso();
  const rows = bucketRows(leads);
  const files: RetargetBucketFile[] = [];

  if (writeLatest) {
    const latestDir = path.resolve(config.retargetDir, "latest");
    files.push(...(await writeBucketFiles(latestDir, rows, false)));
  }

  if (writeSnapshot) {
    const runDir = path.resolve(config.retargetDir, "runs", toRunStamp(options?.label));
    files.push(...(await writeBucketFiles(runDir, rows, true)));
  }

  return {
    generatedAt,
    summary: summarizeRetargetBuckets(leads),
    files
  };
}
