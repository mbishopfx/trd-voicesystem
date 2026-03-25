import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { config } from "./config.js";
import { normalizePhone } from "./phone.js";
import { withState } from "./store.js";
import type { IngestSummary, Lead } from "./types.js";
import { coerceString, firstDefined, hashShort, isMainModule, nowIso, parseBoolean } from "./utils.js";

const aliases = {
  phone: [
    "phone",
    "phone_number",
    "mobile",
    "mobile_phone",
    "cell",
    "cell_phone",
    "business_phone",
    "work_phone",
    "direct_phone",
    "direct_dial",
    "telephone",
    "tel"
  ],
  firstName: ["first_name", "firstname", "first", "given_name", "contact_first_name"],
  lastName: ["last_name", "lastname", "last", "surname", "family_name", "contact_last_name"],
  fullName: ["full_name", "fullname", "contact_name", "name", "contact"],
  company: ["company", "company_name", "business", "business_name", "organization", "organisation", "account_name"],
  email: ["email", "email_address", "business_email", "work_email", "company_email"],
  timezone: ["timezone", "time_zone", "tz", "timezone_name", "time_zone_name"],
  campaign: ["campaign", "campaign_name", "list_name", "list", "source"],
  findings: ["findings", "audit_summary", "discovery", "pain_point"],
  notes: ["notes", "note", "comments", "comment"],
  dnc: ["dnc", "do_not_call", "do_not_contact", "unsubscribed", "opt_out"],
  optIn: ["opt_in", "optin", "consent", "permission", "warm_lead", "opted_in", "permission_to_contact"]
} as const;

type CsvRow = Record<string, unknown>;
interface IngestOptions {
  trustImportLeads?: boolean;
}

const normalizedRowCache = new WeakMap<CsvRow, Record<string, unknown>>();

function normalizeHeaderKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" && !value.trim()) return true;
  return false;
}

function normalizedRow(row: CsvRow): Record<string, unknown> {
  const cached = normalizedRowCache.get(row);
  if (cached) return cached;

  const map: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const normalized = normalizeHeaderKey(key);
    if (!normalized) continue;
    if (!(normalized in map) || (isMissing(map[normalized]) && !isMissing(value))) {
      map[normalized] = value;
    }
  }

  normalizedRowCache.set(row, map);
  return map;
}

function pick(row: CsvRow, keys: readonly string[]): unknown {
  const normalized = normalizedRow(row);

  for (const key of keys) {
    const direct = row[key];
    if (direct !== undefined) return direct;

    // Case-insensitive fallback for inconsistent CSV headers.
    const found = Object.entries(row).find(([k]) => k.trim().toLowerCase() === key.toLowerCase());
    if (found) return found[1];

    const normalizedMatch = normalized[normalizeHeaderKey(key)];
    if (normalizedMatch !== undefined) return normalizedMatch;
  }
  return undefined;
}

function pickByHeaderHint(
  row: CsvRow,
  options: {
    includeAny: string[];
    includeAll?: string[];
    exclude?: string[];
    validator?: (value: string) => boolean;
  }
): unknown {
  const includeAny = options.includeAny.map(normalizeHeaderKey).filter(Boolean);
  const includeAll = (options.includeAll || []).map(normalizeHeaderKey).filter(Boolean);
  const exclude = (options.exclude || []).map(normalizeHeaderKey).filter(Boolean);

  for (const [header, raw] of Object.entries(row)) {
    const value = coerceString(raw);
    if (!value) continue;

    const headerNorm = normalizeHeaderKey(header);
    if (!headerNorm) continue;
    if (exclude.some((token) => token && headerNorm.includes(token))) continue;
    if (includeAny.length > 0 && !includeAny.some((token) => token && headerNorm.includes(token))) continue;
    if (includeAll.length > 0 && !includeAll.every((token) => token && headerNorm.includes(token))) continue;
    if (options.validator && !options.validator(value)) continue;
    return raw;
  }

  return undefined;
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function splitPersonalName(fullName?: string): { firstName?: string; lastName?: string } {
  const value = coerceString(fullName);
  if (!value) return {};
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" ")
  };
}

function buildLead(row: CsvRow, sourceFile: string, sourceRow: number, options?: IngestOptions): Lead | undefined {
  const phone = normalizePhone(
    firstDefined(
      pick(row, aliases.phone),
      pickByHeaderHint(row, {
        includeAny: ["phone", "mobile", "cell", "telephone", "tel"],
        exclude: ["quality", "score", "status", "country", "type", "extension", "ext", "url"],
        validator: (value) => Boolean(normalizePhone(value))
      })
    )
  );
  if (!phone) return undefined;

  const now = nowIso();
  const fullName = coerceString(
    firstDefined(
      pick(row, aliases.fullName),
      pickByHeaderHint(row, {
        includeAny: ["name"],
        exclude: ["company", "business", "job", "title", "industry"]
      })
    )
  );
  const parsedName = splitPersonalName(fullName);

  const firstName =
    coerceString(
      firstDefined(
        pick(row, aliases.firstName),
        pickByHeaderHint(row, {
          includeAny: ["firstname"],
          includeAll: ["first", "name"],
          exclude: ["company", "business"]
        })
      )
    ) || parsedName.firstName;

  const lastName =
    coerceString(
      firstDefined(
        pick(row, aliases.lastName),
        pickByHeaderHint(row, {
          includeAny: ["lastname", "surname"],
          includeAll: ["last", "name"],
          exclude: ["company", "business"]
        })
      )
    ) || parsedName.lastName;

  const company = coerceString(
    firstDefined(
      pick(row, aliases.company),
      pickByHeaderHint(row, {
        includeAny: ["company", "business", "organization", "organisation", "account", "employer"],
        exclude: ["url", "website", "domain", "industry", "country", "city", "state", "size", "range", "employee"]
      })
    )
  );
  const emailRaw = coerceString(
    firstDefined(
      pick(row, aliases.email),
      pickByHeaderHint(row, {
        includeAny: ["email"],
        exclude: ["quality", "score", "status", "verified", "validation"],
        validator: isEmailLike
      })
    )
  );
  const email = emailRaw && isEmailLike(emailRaw) ? emailRaw : undefined;

  const importTrusted = options?.trustImportLeads ?? config.trustAllImports;
  const optInRaw = parseBoolean(
    firstDefined(
      pick(row, aliases.optIn),
      pickByHeaderHint(row, {
        includeAny: ["optin", "consent", "permission", "subscribed", "warm"],
        exclude: ["optout", "unsubscribe", "dnc", "donotcall"]
      })
    )
  );
  const optIn = importTrusted ? true : optInRaw;
  const dnc = parseBoolean(
    firstDefined(
      pick(row, aliases.dnc),
      pickByHeaderHint(row, {
        includeAny: ["dnc", "donotcall", "donotcontact", "unsubscribe", "optout", "blacklist"]
      })
    )
  );
  const status = dnc || (config.requireOptIn && !optIn) ? "blocked" : "queued";

  const industry = coerceString(
    pickByHeaderHint(row, {
      includeAny: ["industry"],
      exclude: ["code", "id"]
    })
  );
  const title = coerceString(
    pickByHeaderHint(row, {
      includeAny: ["jobtitle", "title", "role"],
      exclude: ["company", "business"]
    })
  );

  const findings = coerceString(
    firstDefined(
      pick(row, aliases.findings),
      industry ? `Industry: ${industry}` : undefined
    )
  );
  const notes = coerceString(
    firstDefined(
      pick(row, aliases.notes),
      title ? `Role: ${title}` : undefined
    )
  );

  return {
    id: hashShort(phone),
    phone,
    firstName,
    lastName,
    company,
    email,
    timezone:
      firstDefined(
        pick(row, aliases.timezone),
        pickByHeaderHint(row, {
          includeAny: ["timezone", "tz"],
          exclude: ["offsetminutes", "offsetseconds"]
        }),
        config.defaultTimezone
      ) || config.defaultTimezone,
    campaign:
      firstDefined(
        pick(row, aliases.campaign),
        pickByHeaderHint(row, {
          includeAny: ["campaign", "list", "source"],
          exclude: ["sourcefile", "sourcesystem"]
        }),
        config.campaignName
      ) || config.campaignName,
    sourceFile,
    sourceRow,
    findings,
    notes,
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
