import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { config } from "./config.js";
import { normalizePhone } from "./phone.js";
import { withState } from "./store.js";
import type { IngestSummary, Lead } from "./types.js";
import { coerceString, firstDefined, hashShort, isMainModule, nowIso, parseBoolean } from "./utils.js";

const aliases = {
  phone: ["phone", "phone_number", "mobile", "mobile_phone"],
  firstName: ["first_name", "firstname", "first"],
  lastName: ["last_name", "lastname", "last"],
  company: ["company", "business", "business_name"],
  email: ["email", "email_address"],
  timezone: ["timezone", "time_zone", "tz"],
  campaign: ["campaign", "campaign_name", "list_name"],
  findings: ["findings", "audit_summary", "discovery", "pain_point"],
  notes: ["notes", "note"],
  dnc: ["dnc", "do_not_call", "unsubscribed"],
  optIn: ["opt_in", "optin", "consent", "permission", "warm_lead"]
} as const;

type CsvRow = Record<string, unknown>;
interface IngestOptions {
  trustImportLeads?: boolean;
}

function pick(row: CsvRow, keys: readonly string[]): unknown {
  for (const key of keys) {
    const direct = row[key];
    if (direct !== undefined) return direct;

    // Case-insensitive fallback for inconsistent CSV headers.
    const found = Object.entries(row).find(([k]) => k.trim().toLowerCase() === key.toLowerCase());
    if (found) return found[1];
  }
  return undefined;
}

function buildLead(row: CsvRow, sourceFile: string, sourceRow: number, options?: IngestOptions): Lead | undefined {
  const phone = normalizePhone(pick(row, aliases.phone));
  if (!phone) return undefined;

  const now = nowIso();
  const firstName = coerceString(pick(row, aliases.firstName));
  const lastName = coerceString(pick(row, aliases.lastName));
  const company = coerceString(pick(row, aliases.company));

  const importTrusted = options?.trustImportLeads ?? config.trustAllImports;
  const optInRaw = parseBoolean(pick(row, aliases.optIn));
  const optIn = importTrusted ? true : optInRaw;
  const dnc = parseBoolean(pick(row, aliases.dnc));
  const status = dnc || (config.requireOptIn && !optIn) ? "blocked" : "queued";

  return {
    id: hashShort(phone),
    phone,
    firstName,
    lastName,
    company,
    email: coerceString(pick(row, aliases.email)),
    timezone: firstDefined(pick(row, aliases.timezone), config.defaultTimezone) || config.defaultTimezone,
    campaign: firstDefined(pick(row, aliases.campaign), config.campaignName) || config.campaignName,
    sourceFile,
    sourceRow,
    findings: coerceString(pick(row, aliases.findings)),
    notes: coerceString(pick(row, aliases.notes)),
    optIn,
    dnc,
    status,
    attempts: 0,
    nextAttemptAt: status === "queued" ? now : undefined,
    createdAt: now,
    updatedAt: now
  };
}

function shouldReactivateBlockedLead(existing: Lead, incoming: Lead, options?: IngestOptions): boolean {
  const importTrusted = options?.trustImportLeads ?? config.trustAllImports;
  if (!importTrusted) return false;
  if (existing.status !== "blocked") return false;
  if (existing.dnc || incoming.dnc) return false;
  if (existing.attempts > 0) return false;
  if (existing.callAttemptedAt) return false;
  return true;
}

function reactivateLeadFromImport(existing: Lead, incoming: Lead): void {
  const now = nowIso();
  existing.firstName = incoming.firstName || existing.firstName;
  existing.lastName = incoming.lastName || existing.lastName;
  existing.company = incoming.company || existing.company;
  existing.email = incoming.email || existing.email;
  existing.findings = incoming.findings || existing.findings;
  existing.notes = incoming.notes || existing.notes;
  existing.timezone = incoming.timezone || existing.timezone;
  existing.campaign = incoming.campaign || existing.campaign;
  existing.sourceFile = incoming.sourceFile;
  existing.sourceRow = incoming.sourceRow;
  existing.optIn = true;
  existing.dnc = false;
  existing.status = "queued";
  existing.lastError = undefined;
  existing.nextAttemptAt = now;
  existing.updatedAt = now;
}

async function listCsvFiles(): Promise<string[]> {
  await fs.mkdir(config.incomingDir, { recursive: true });
  const entries = await fs.readdir(config.incomingDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
    .map((entry) => path.resolve(config.incomingDir, entry.name))
    .sort();
}

async function archiveFile(filePath: string): Promise<void> {
  await fs.mkdir(config.processedDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const destination = path.resolve(config.processedDir, `${stamp}-${path.basename(filePath)}`);
  await fs.rename(filePath, destination);
}

function parseRows(csvRaw: string): CsvRow[] {
  return parse(csvRaw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as CsvRow[];
}

export async function ingestOnce(options?: IngestOptions): Promise<IngestSummary[]> {
  const files = await listCsvFiles();
  const summaries: IngestSummary[] = [];

  for (const file of files) {
    const sourceFile = path.basename(file);
    const csvRaw = await fs.readFile(file, "utf8");
    const rows = parseRows(csvRaw);

    const summary: IngestSummary = {
      file: sourceFile,
      rows: rows.length,
      accepted: 0,
      blocked: 0,
      duplicates: 0,
      invalid: 0
    };

    await withState(async (state) => {
      if (state.filesProcessed.includes(sourceFile)) {
        summary.duplicates = rows.length;
        return;
      }

      for (let i = 0; i < rows.length; i += 1) {
        const lead = buildLead(rows[i], sourceFile, i + 2, options);
        if (!lead) {
          summary.invalid += 1;
          continue;
        }

        const existingLead = state.leads[lead.id];
        if (existingLead) {
          if (shouldReactivateBlockedLead(existingLead, lead, options)) {
            reactivateLeadFromImport(existingLead, lead);
            summary.accepted += 1;
            continue;
          }
          summary.duplicates += 1;
          continue;
        }

        state.leads[lead.id] = lead;
        if (lead.status === "blocked") {
          summary.blocked += 1;
        } else {
          summary.accepted += 1;
        }
      }

      state.filesProcessed.push(sourceFile);
    });

    await archiveFile(file);
    summaries.push(summary);
  }

  return summaries;
}

async function main(): Promise<void> {
  const summaries = await ingestOnce();
  if (summaries.length === 0) {
    console.log("No CSV files found in data/incoming");
    return;
  }

  for (const summary of summaries) {
    console.log(
      `[INGEST] ${summary.file} rows=${summary.rows} accepted=${summary.accepted} blocked=${summary.blocked} duplicates=${summary.duplicates} invalid=${summary.invalid}`
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
