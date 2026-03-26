import { config } from "../config.js";
import type { Lead } from "../types.js";
import { runtimeError, runtimeInfo } from "../runtimeLogs.js";

interface GhlCredentials {
  apiKey: string;
  locationId: string;
  baseUrl: string;
  version: string;
}

interface GhlResponse {
  status: number;
  data: Record<string, unknown>;
}

export interface GhlSmartListContact {
  id?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  timezone?: string;
  companyName?: string;
  tags?: string[];
  raw?: Record<string, unknown>;
}

export interface GhlSmartListFetchResult {
  contacts: GhlSmartListContact[];
  attempts: Array<{ mode: string; page: number; status: number; count: number }>;
}

export interface GhlLocationContactsResult {
  contacts: GhlSmartListContact[];
  attempts: Array<{ page: number; status: number; count: number }>;
}

export interface GhlSyncInput {
  lead: Lead;
  outcome?: string;
  transcript?: string;
  bookingSource?: string;
  force?: boolean;
}

export interface GhlSyncResult {
  synced: boolean;
  contactId?: string;
  error?: string;
}

export interface ProspectorGhlSyncInput {
  lead: Lead;
  deployedSiteUrl?: string;
  generatedSitePath?: string;
  force?: boolean;
}

export interface BulkSchedulerGhlLogInput {
  lead: Lead;
  runId: string;
  trigger: "scheduled" | "manual";
  contactId?: string;
  queuedAt?: string;
}

function creds(): GhlCredentials | undefined {
  if (!config.ghlApiKey || !config.ghlLocationId) return undefined;
  return {
    apiKey: config.ghlApiKey,
    locationId: config.ghlLocationId,
    baseUrl: config.ghlBaseUrl,
    version: config.ghlApiVersion
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonHeaders(c: GhlCredentials): Record<string, string> {
  return {
    Authorization: `Bearer ${c.apiKey}`,
    Version: c.version,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

async function readJsonSafe(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

async function ghlRequest(
  c: GhlCredentials,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<GhlResponse> {
  const response = await fetch(`${c.baseUrl}${path}`, {
    method,
    headers: jsonHeaders(c),
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await readJsonSafe(response);
  return { status: response.status, data };
}

function parseContacts(data: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(data.contacts)) {
    return data.contacts.filter((item): item is Record<string, unknown> => Boolean(asObject(item)));
  }

  const dataObj = asObject(data.data);
  if (dataObj && Array.isArray(dataObj.contacts)) {
    return dataObj.contacts.filter((item): item is Record<string, unknown> => Boolean(asObject(item)));
  }

  return [];
}

function mapSmartListContact(row: Record<string, unknown>): GhlSmartListContact {
  const phone = asString(row.phone) || asString(row.mobile) || asString((asObject(row.contact) || {}).phone);
  return {
    id: asString(row.id) || asString((asObject(row.contact) || {}).id),
    firstName: asString(row.firstName) || asString((asObject(row.contact) || {}).firstName),
    lastName: asString(row.lastName) || asString((asObject(row.contact) || {}).lastName),
    name: asString(row.name) || asString((asObject(row.contact) || {}).name),
    email: asString(row.email) || asString((asObject(row.contact) || {}).email),
    phone,
    timezone: asString(row.timezone) || asString((asObject(row.contact) || {}).timezone),
    companyName: asString(row.companyName) || asString((asObject(row.contact) || {}).companyName),
    tags: Array.isArray(row.tags)
      ? row.tags
          .map((tag) => asString(tag))
          .filter((tag): tag is string => Boolean(tag))
      : undefined,
    raw: row
  };
}

export async function fetchSmartListContacts(
  filterId: string,
  opts?: { pageLimit?: number; maxPages?: number }
): Promise<GhlSmartListFetchResult> {
  const c = creds();
  if (!c) {
    throw new Error("GHL not configured");
  }

  const normalizedFilterId = filterId.trim();
  if (!normalizedFilterId) {
    throw new Error("smart list filterId is required");
  }

  const pageLimit = Math.min(200, Math.max(10, Math.trunc(opts?.pageLimit || 100)));
  const maxPages = Math.min(50, Math.max(1, Math.trunc(opts?.maxPages || 10)));
  const attempts: Array<{ mode: string; page: number; status: number; count: number }> = [];
  const unique = new Map<string, GhlSmartListContact>();

  const payloadBuilders: Array<{ mode: string; build: (page: number) => Record<string, unknown> }> = [
    {
      mode: "body.smartListId",
      build: (page) => ({
        locationId: c.locationId,
        page,
        pageLimit,
        smartListId: normalizedFilterId
      })
    },
    {
      mode: "body.filterId",
      build: (page) => ({
        locationId: c.locationId,
        page,
        pageLimit,
        filterId: normalizedFilterId
      })
    },
    {
      mode: "body.filters.smartListId",
      build: (page) => ({
        locationId: c.locationId,
        page,
        pageLimit,
        filters: [{ field: "smartListId", operator: "eq", value: normalizedFilterId }]
      })
    }
  ];

  let selectedMode: string | undefined;
  for (let page = 1; page <= maxPages; page += 1) {
    let pageAccepted = false;
    let pageCount = 0;

    for (const builder of payloadBuilders) {
      if (selectedMode && selectedMode !== builder.mode) continue;
      const payload = builder.build(page);
      const response = await ghlRequest(c, "POST", "/contacts/search", payload);
      const rows = response.status >= 200 && response.status < 300 ? parseContacts(response.data) : [];
      attempts.push({ mode: builder.mode, page, status: response.status, count: rows.length });
      const errorHint =
        response.status >= 200 && response.status < 300
          ? ""
          : asString(response.data.message) || asString(response.data.error) || asString(response.data.raw) || "";

      runtimeInfo("ghl", "smart list fetch attempt", {
        mode: builder.mode,
        page,
        status: response.status,
        count: rows.length,
        errorHint: errorHint ? errorHint.slice(0, 180) : ""
      });

      if (response.status >= 200 && response.status < 300) {
        selectedMode = builder.mode;
        pageAccepted = true;
        pageCount = rows.length;
        for (const row of rows) {
          const mapped = mapSmartListContact(row);
          const dedupeKey = mapped.id || mapped.phone || mapped.email || JSON.stringify(row);
          unique.set(dedupeKey, mapped);
        }
        break;
      }
    }

    if (!pageAccepted) {
      if (page === 1) {
        throw new Error(
          `Could not fetch contacts for smart list filterId=${normalizedFilterId}. API may require manual export for this account.`
        );
      }
      break;
    }

    if (pageCount < pageLimit) break;
  }

  const contacts = Array.from(unique.values());
  runtimeInfo("ghl", "smart list fetch complete", {
    filterId: normalizedFilterId,
    contacts: contacts.length,
    attempts: attempts.length,
    mode: selectedMode || "none"
  });
  return { contacts, attempts };
}

export async function fetchLocationContacts(opts?: {
  pageLimit?: number;
  maxPages?: number;
}): Promise<GhlLocationContactsResult> {
  const c = creds();
  if (!c) {
    throw new Error("GHL not configured");
  }

  const pageLimit = Math.min(200, Math.max(10, Math.trunc(opts?.pageLimit || 100)));
  const maxPages = Math.min(50, Math.max(1, Math.trunc(opts?.maxPages || 10)));
  const attempts: Array<{ page: number; status: number; count: number }> = [];
  const unique = new Map<string, GhlSmartListContact>();

  for (let page = 1; page <= maxPages; page += 1) {
    const payload: Record<string, unknown> = {
      locationId: c.locationId,
      page,
      pageLimit
    };

    const response = await ghlRequest(c, "POST", "/contacts/search", payload);
    const rows = response.status >= 200 && response.status < 300 ? parseContacts(response.data) : [];
    attempts.push({ page, status: response.status, count: rows.length });
    runtimeInfo("ghl", "location contacts fetch attempt", {
      page,
      status: response.status,
      count: rows.length
    });

    if (!(response.status >= 200 && response.status < 300)) {
      if (page === 1) {
        throw new Error(`Unable to fetch location contacts from GHL (status=${response.status}).`);
      }
      break;
    }

    for (const row of rows) {
      const mapped = mapSmartListContact(row);
      const dedupeKey = mapped.id || mapped.phone || mapped.email || JSON.stringify(row);
      unique.set(dedupeKey, mapped);
    }

    if (rows.length < pageLimit) break;
  }

  const contacts = Array.from(unique.values());
  runtimeInfo("ghl", "location contacts fetch complete", {
    contacts: contacts.length,
    attempts: attempts.length
  });
  return { contacts, attempts };
}

function extractContactId(data: Record<string, unknown>): string | undefined {
  const direct = data.id;
  if (typeof direct === "string" && direct) return direct;

  const contact = data.contact;
  if (contact && typeof contact === "object") {
    const id = (contact as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id;
  }

  const contacts = data.contacts;
  if (Array.isArray(contacts) && contacts.length > 0) {
    const first = contacts[0];
    if (first && typeof first === "object") {
      const id = (first as Record<string, unknown>).id;
      if (typeof id === "string" && id) return id;
    }
  }

  return undefined;
}

async function upsertContact(c: GhlCredentials, lead: Lead, tags: string[]): Promise<string> {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || asString(lead.company) || "";
  const phone = asString(lead.phone);
  const email = asString(lead.email);

  const payload: Record<string, unknown> = {
    locationId: c.locationId,
    firstName: lead.firstName,
    lastName: lead.lastName,
    name: name || undefined,
    phone: phone || undefined,
    email: email || undefined,
    companyName: lead.company,
    tags
  };

  const upsertRes = await ghlRequest(c, "POST", "/contacts/upsert", payload);
  let contactId = extractContactId(upsertRes.data);
  if (upsertRes.status >= 200 && upsertRes.status < 300 && contactId) {
    return contactId;
  }

  const createRes = await ghlRequest(c, "POST", "/contacts/", payload);
  contactId = extractContactId(createRes.data);
  if (createRes.status >= 200 && createRes.status < 300 && contactId) {
    return contactId;
  }

  if (phone || email) {
    const query = new URLSearchParams({ locationId: c.locationId });
    if (phone) query.set("number", phone);
    if (email) query.set("email", email);
    const duplicateRes = await ghlRequest(c, "GET", `/contacts/search/duplicate?${query.toString()}`);
    contactId = extractContactId(duplicateRes.data);
    if (duplicateRes.status >= 200 && duplicateRes.status < 300 && contactId) {
      return contactId;
    }
  }

  throw new Error(`Unable to upsert contact in GHL. status=${upsertRes.status}/${createRes.status}`);
}

async function addTags(c: GhlCredentials, contactId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  await ghlRequest(c, "POST", `/contacts/${contactId}/tags`, { tags });
}

async function addNote(c: GhlCredentials, contactId: string, note: string): Promise<void> {
  const variants: Array<Record<string, unknown>> = [
    { body: note },
    { note },
    { content: note }
  ];

  for (const payload of variants) {
    const response = await ghlRequest(c, "POST", `/contacts/${contactId}/notes`, payload);
    if (response.status >= 200 && response.status < 300) {
      return;
    }
  }
}

function compactTags(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v && v.trim())).map((v) => v.trim()))];
}

function normalizeOutcomeTag(value?: string): string | undefined {
  if (!value) return undefined;
  const base = value.split(";")[0] || "";
  const normalized = base.trim().toLowerCase().replace(/\s+/g, "_");
  return normalized || undefined;
}

function buildNote(input: GhlSyncInput): string {
  const lines = [
    `AI Outbound Attempt: ${input.lead.lastAttemptAt || input.lead.callAttemptedAt || "unknown"}`,
    `Outcome: ${input.outcome || input.lead.outcome || "unknown"}`,
    `Campaign: ${input.lead.campaign}`,
    `Company: ${input.lead.company || ""}`,
    `Booking Source: ${input.bookingSource || input.lead.bookingSource || ""}`,
    `Call ID: ${input.lead.callId || ""}`,
    `Transcript:\n${input.transcript || input.lead.transcript || "(not available)"}`
  ];

  return lines.join("\n").trim();
}

export function isGhlConfigured(): boolean {
  return Boolean(creds());
}

export async function syncLeadToGhl(input: GhlSyncInput): Promise<GhlSyncResult> {
  const c = creds();
  if (!c) {
    return { synced: false, error: "GHL not configured" };
  }

  if (!input.force && input.lead.attempts < 1) {
    return { synced: false, error: "Lead has no call attempt yet" };
  }

  const outcomeTag = normalizeOutcomeTag(input.outcome || input.lead.outcome);
  const tags = compactTags([
    "jarvis-voice",
    "ai-called",
    outcomeTag ? `ai-outcome:${outcomeTag}` : undefined,
    input.bookingSource ? `booked:${input.bookingSource}` : undefined
  ]);

  try {
    const contactId = await upsertContact(c, input.lead, tags);
    await addTags(c, contactId, tags);

    const note = buildNote(input);
    await addNote(c, contactId, note);

    runtimeInfo("ghl", "lead synced", {
      leadId: input.lead.id,
      contactId,
      outcome: input.outcome || input.lead.outcome || "",
      bookingSource: input.bookingSource || input.lead.bookingSource || ""
    });

    return { synced: true, contactId };
  } catch (error) {
    runtimeError("ghl", "lead sync failed", error, {
      leadId: input.lead.id,
      outcome: input.outcome || input.lead.outcome || ""
    });
    return { synced: false, error: String(error) };
  }
}

export async function syncProspectorContactToGhl(input: ProspectorGhlSyncInput): Promise<GhlSyncResult> {
  const c = creds();
  if (!c) {
    return { synced: false, error: "GHL not configured" };
  }

  const tags = compactTags([
    "jarvis-prospector",
    "ai-prospector",
    input.lead.prospectIcp ? `prospector-icp:${input.lead.prospectIcp.toLowerCase().replace(/\s+/g, "_")}` : undefined,
    input.deployedSiteUrl ? "prospector-site-deployed" : "prospector-site-generated"
  ]);

  const note = [
    `Prospector Lead: ${input.lead.company || input.lead.id}`,
    `Market: ${input.lead.prospectCity || ""}, ${input.lead.prospectState || ""}`,
    `ICP: ${input.lead.prospectIcp || ""}`,
    `Live Link: ${input.deployedSiteUrl || "(not deployed yet)"}`,
    `Deploy Link: ${input.deployedSiteUrl || "(not deployed yet)"}`,
    `Generated File: ${input.generatedSitePath || input.lead.generatedSitePath || ""}`,
    `Findings: ${input.lead.findings || ""}`,
    `Updated At: ${input.lead.updatedAt}`
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  try {
    const contactId = await upsertContact(c, input.lead, tags);
    await addTags(c, contactId, tags);
    await addNote(c, contactId, note);
    runtimeInfo("ghl", "prospector lead synced", {
      leadId: input.lead.id,
      contactId,
      deployedSiteUrl: input.deployedSiteUrl || ""
    });
    return { synced: true, contactId };
  } catch (error) {
    runtimeError("ghl", "prospector sync failed", error, {
      leadId: input.lead.id,
      deployedSiteUrl: input.deployedSiteUrl || ""
    });
    return { synced: false, error: String(error) };
  }
}

export async function logBulkSchedulerQueuedContact(input: BulkSchedulerGhlLogInput): Promise<GhlSyncResult> {
  const c = creds();
  if (!c) {
    return { synced: false, error: "GHL not configured" };
  }

  const tags = compactTags([
    "jarvis-voice",
    "jarvis-bulk-scheduler",
    "bulk-campaign-queued",
    input.trigger === "scheduled" ? "bulk-run:scheduled" : "bulk-run:manual"
  ]);
  const queuedAt = input.queuedAt || input.lead.updatedAt || "";
  const note = [
    "Jarvis bulk campaign queued this contact.",
    `Run ID: ${input.runId}`,
    `Trigger: ${input.trigger}`,
    `Campaign: ${input.lead.campaign || config.campaignName}`,
    `Lead ID: ${input.lead.id}`,
    `Queued At: ${queuedAt}`,
    `Phone: ${input.lead.phone || ""}`
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const contactId = input.contactId || (await upsertContact(c, input.lead, tags));
    await addTags(c, contactId, tags);
    await addNote(c, contactId, note);
    runtimeInfo("ghl", "bulk scheduler lead queued note logged", {
      leadId: input.lead.id,
      contactId,
      runId: input.runId
    });
    return { synced: true, contactId };
  } catch (error) {
    runtimeError("ghl", "bulk scheduler queue log failed", error, {
      leadId: input.lead.id,
      runId: input.runId
    });
    return { synced: false, error: String(error) };
  }
}
