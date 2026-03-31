import { config } from "./config.js";
import { deployGeneratedProspects } from "./deploy.js";
import { generateReadyProspectSites } from "./generation.js";
import { syncProspectorContactToGhl } from "./integrations/ghl.js";
import { normalizePhone } from "./phone.js";
import { startProspectorRun } from "./prospector.js";
import { appendProspectorPhaseRecord } from "./prospectorRecords.js";
import { runtimeError } from "./runtimeLogs.js";
import { withState } from "./store.js";
import type { Lead } from "./types.js";
import { nowIso } from "./utils.js";
import { createOutboundCall } from "./vapiClient.js";

export interface ProspectorPipelineInput {
  icp?: string;
  city?: string;
  state?: string;
  limit?: number;
  runPhase1?: boolean;
  runPhase2?: boolean;
  runPhase3?: boolean;
  runPhase4?: boolean;
  runPhase5?: boolean;
  dryRunCalls?: boolean;
  assistantId?: string;
}

export interface ProspectorPipelineResult {
  phase1?: { createdRunId: string; discovered: number };
  phase2?: { generated: number; deployed: number; leadIds: string[]; generationFailed: number; deployFailed: number };
  phase3?: { organized: number; ghlSynced: number; skipped: number };
  phase4?: { scripted: number; skipped: number };
  phase5?: { queued: number; skipped: number; failed: number; callIds: string[]; error?: string };
  errors?: Array<{ phase: 1 | 2 | 3 | 4 | 5; error: string }>;
}

export interface ProspectorPhase3Options {
  limit?: number;
  forceGhlSync?: boolean;
}

function appendNote(base: string | undefined, message: string): string {
  const current = (base || "").trim();
  if (!current) return message;
  if (current.includes(message)) return current;
  return `${current}\n${message}`;
}

function toVoiceVariables(lead: Lead): Record<string, string> {
  return {
    leadCompany: lead.company || "",
    leadFirstName: lead.firstName || "",
    leadFindings: lead.findings || "",
    prospectorSiteUrl: lead.deployedSiteUrl || "",
    prospectorScreenshotPath: lead.generatedScreenshotPath || "",
    prospectorAddress: lead.prospectAddress || "",
    prospectorMarket: [lead.prospectCity, lead.prospectState].filter(Boolean).join(", "),
    prospectorIcp: lead.prospectIcp || "",
    bookingUrl: config.bookingUrl || config.bookingUrlCalendly || config.bookingUrlGoogleCalendar || ""
  };
}

function buildProspectorVoiceScript(lead: Lead): string {
  const company = lead.company || "your business";
  const market = [lead.prospectCity, lead.prospectState].filter(Boolean).join(", ") || "your market";
  const siteUrl = lead.deployedSiteUrl || "the vision link";
  return [
    `You are Jarvis with True Rank Digital handling a specialized prospector outreach call for ${company}.`,
    "Open direct without filler acknowledgements.",
    `Reference market context (${market}) and one concrete finding from leadFindings.`,
    `Tell them we built a custom UX vision and can text the live link: ${siteUrl}.`,
    "If interested, send SMS immediately with both the live link and booking link, and mention a team member may reach out before the meeting.",
    "Keep under 3 minutes. Respect opt-out requests and end politely if uninterested.",
    "Do not use the bulk campaign framing."
  ].join(" ");
}

async function listProspectorLeads(limit: number, predicate: (lead: Lead) => boolean): Promise<Lead[]> {
  return withState((state) =>
    Object.values(state.leads)
      .filter((lead) => lead.sourceFile === "prospector-dashboard")
      .filter(predicate)
      .sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""))
      .slice(0, limit)
      .map((lead) => ({ ...lead }))
  );
}

async function safeAppendRecord(input: Parameters<typeof appendProspectorPhaseRecord>[0]): Promise<void> {
  try {
    await appendProspectorPhaseRecord(input);
  } catch (error) {
    runtimeError("agent", "prospector phase record write failed", error, {
      leadId: input.leadId,
      phase: input.phase
    });
  }
}

export async function runProspectorPhase2(
  limit = 10
): Promise<{ generated: number; deployed: number; leadIds: string[]; generationFailed: number; deployFailed: number }> {
  const generated = await generateReadyProspectSites(limit);
  const deployed = await deployGeneratedProspects(limit);
  const updatedAt = nowIso();

  await withState((state) => {
    for (const leadId of deployed.leads) {
      const lead = state.leads[leadId];
      if (!lead) continue;
      lead.prospectorPhase = 2;
      lead.prospectorPhaseStatus = "phase2_built_and_deployed";
      lead.handoffStatus = lead.handoffStatus || "ready_for_review";
      lead.updatedAt = updatedAt;
    }
  });

  for (const leadId of generated.leads) {
    const lead = await withState((state) => {
      const row = state.leads[leadId];
      return row ? { ...row } : undefined;
    });
    if (!lead) continue;
    await safeAppendRecord({
      leadId,
      phase: 2,
      status: "success",
      message: "Phase 2 page generated",
      company: lead.company,
      generatedSitePath: lead.generatedSitePath,
      payload: {
        source: lead.prospectorTemplateSource,
        model: lead.prospectorTemplateModel,
        promptVersion: lead.prospectorPromptVersion
      }
    });
  }

  for (const failed of generated.failedLeads) {
    await safeAppendRecord({
      leadId: failed.leadId,
      phase: 2,
      status: "error",
      message: "Phase 2 page generation failed",
      payload: { error: failed.error }
    });
  }

  for (const leadId of deployed.leads) {
    const lead = await withState((state) => {
      const row = state.leads[leadId];
      return row ? { ...row } : undefined;
    });
    if (!lead) continue;
    await safeAppendRecord({
      leadId,
      phase: 2,
      status: "success",
      message: "Phase 2 deployed to Vercel",
      company: lead.company,
      deployedSiteUrl: lead.deployedSiteUrl,
      generatedSitePath: lead.generatedSitePath,
      payload: { deployName: lead.prospectDeployName || "" }
    });
  }

  for (const failed of deployed.failedLeads) {
    await safeAppendRecord({
      leadId: failed.leadId,
      phase: 2,
      status: "error",
      message: "Phase 2 deploy failed",
      payload: { error: failed.error }
    });
  }

  return {
    generated: generated.generated,
    deployed: deployed.deployed,
    leadIds: Array.from(new Set([...generated.leads, ...deployed.leads])),
    generationFailed: generated.failed,
    deployFailed: deployed.failed
  };
}

export async function runProspectorPhase3(input: number | ProspectorPhase3Options = 50): Promise<{ organized: number; ghlSynced: number; skipped: number }> {
  const options: ProspectorPhase3Options =
    typeof input === "number" ? { limit: input } : input || {};
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit || 50)));
  const forceGhlSync = Boolean(options.forceGhlSync);
  const leads = await listProspectorLeads(limit, (lead) => Boolean(lead.deployedSiteUrl));
  let organized = 0;
  let ghlSynced = 0;
  let skipped = 0;

  for (const lead of leads) {
    let ghlContactId: string | undefined;
    let ghlSyncError: string | undefined;
    if (config.prospectorGhlAutoSync || forceGhlSync) {
      const synced = await syncProspectorContactToGhl({
        lead,
        deployedSiteUrl: lead.deployedSiteUrl,
        generatedSitePath: lead.generatedSitePath
      });
      if (synced.synced) {
        ghlSynced += 1;
        ghlContactId = synced.contactId;
      } else if (synced.error) {
        ghlSyncError = synced.error;
      }
    }

    const updated = await withState((state) => {
      const row = state.leads[lead.id];
      if (!row) return false;
      row.prospectorPhase = 3;
      row.prospectorPhaseStatus = "phase3_linked";
      row.handoffStatus = row.handoffStatus || "ready_for_review";
      row.notes = appendNote(row.notes, `Prospector deploy link: ${row.deployedSiteUrl || ""}`);
      if (ghlContactId) {
        row.ghlContactId = ghlContactId;
        row.prospectorGhlContactId = ghlContactId;
        row.prospectorGhlSyncedAt = nowIso();
      }
      row.updatedAt = nowIso();
      return true;
    });

    if (!updated) {
      skipped += 1;
      continue;
    }
    organized += 1;
    await safeAppendRecord({
      leadId: lead.id,
      phase: 3,
      status: "success",
      message: ghlSyncError ? "Phase 3 organized; GHL sync skipped/failed" : "Phase 3 organized and linked",
      company: lead.company,
      deployedSiteUrl: lead.deployedSiteUrl,
      generatedSitePath: lead.generatedSitePath,
      ghlContactId,
      payload: {
        autoGhlSync: config.prospectorGhlAutoSync,
        forceGhlSync,
        ghlSyncError: ghlSyncError || ""
      }
    });
  }

  return { organized, ghlSynced, skipped };
}

export async function importProspectorLeadsToGhl(
  input: { limit?: number; onlyWithoutGhlContact?: boolean } = {}
): Promise<{ scanned: number; imported: number; failed: number; skipped: number }> {
  const limit = Math.max(1, Math.min(1000, Math.trunc(input.limit || 200)));
  const onlyWithoutGhlContact = input.onlyWithoutGhlContact !== false;
  const leads = await listProspectorLeads(limit, () => true);

  let scanned = 0;
  let imported = 0;
  let failed = 0;
  let skipped = 0;

  for (const lead of leads) {
    scanned += 1;
    const hasGhlContact = Boolean(lead.ghlContactId || lead.prospectorGhlContactId);
    if (onlyWithoutGhlContact && hasGhlContact) {
      skipped += 1;
      continue;
    }

    const synced = await syncProspectorContactToGhl({
      lead,
      deployedSiteUrl: lead.deployedSiteUrl,
      generatedSitePath: lead.generatedSitePath
    });

    if (synced.synced && synced.contactId) {
      imported += 1;
      await withState((state) => {
        const row = state.leads[lead.id];
        if (!row) return;
        row.ghlContactId = synced.contactId;
        row.prospectorGhlContactId = synced.contactId;
        row.ghlSyncedAt = nowIso();
        row.prospectorGhlSyncedAt = row.ghlSyncedAt;
        row.ghlLastError = undefined;
        row.updatedAt = nowIso();
      });
      await safeAppendRecord({
        leadId: lead.id,
        phase: 3,
        status: "success",
        message: "Prospector lead imported to GHL",
        company: lead.company,
        deployedSiteUrl: lead.deployedSiteUrl,
        generatedSitePath: lead.generatedSitePath,
        ghlContactId: synced.contactId,
        payload: {
          mode: "manual_ghl_import"
        }
      });
      continue;
    }

    failed += 1;
    await withState((state) => {
      const row = state.leads[lead.id];
      if (!row) return;
      row.ghlLastError = synced.error || "Unknown GHL import error";
      row.updatedAt = nowIso();
    });
    await safeAppendRecord({
      leadId: lead.id,
      phase: 3,
      status: "error",
      message: "Prospector lead import to GHL failed",
      company: lead.company,
      deployedSiteUrl: lead.deployedSiteUrl,
      generatedSitePath: lead.generatedSitePath,
      payload: {
        mode: "manual_ghl_import",
        error: synced.error || "Unknown GHL import error"
      }
    });
  }

  return { scanned, imported, failed, skipped };
}

export async function runProspectorPhase4(limit = 50): Promise<{ scripted: number; skipped: number }> {
  const leads = await listProspectorLeads(limit, (lead) => Boolean(lead.deployedSiteUrl));
  let scripted = 0;
  let skipped = 0;

  for (const lead of leads) {
    const updated = await withState((state) => {
      const row = state.leads[lead.id];
      if (!row) return false;
      row.prospectorVoiceVariables = toVoiceVariables(row);
      row.prospectorVoiceScript = buildProspectorVoiceScript(row);
      row.prospectorScriptCreatedAt = nowIso();
      row.prospectorPhase = 4;
      row.prospectorPhaseStatus = "phase4_scripted";
      row.updatedAt = nowIso();
      return true;
    });

    if (!updated) {
      skipped += 1;
      continue;
    }
    scripted += 1;
    await safeAppendRecord({
      leadId: lead.id,
      phase: 4,
      status: "success",
      message: "Phase 4 script + variables generated",
      company: lead.company,
      deployedSiteUrl: lead.deployedSiteUrl,
      payload: {
        hasVoiceScript: true
      }
    });
  }

  return { scripted, skipped };
}

export async function runProspectorPhase5(
  input: { limit?: number; leadId?: string; dryRun?: boolean; assistantId?: string } = {}
): Promise<{ queued: number; skipped: number; failed: number; callIds: string[]; error?: string }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit || 10)));
  const dryRun = Boolean(input.dryRun);
  const assistantId = (input.assistantId || config.vapiProspectorAssistantId || "").trim();
  if (!assistantId && !dryRun) {
    throw new Error("Missing VAPI_PROSPECTOR_ASSISTANT_ID. Prospector calls must use a specialized assistant.");
  }
  const assistantError = !assistantId ? "Missing VAPI_PROSPECTOR_ASSISTANT_ID (dry-run only; no calls placed)." : undefined;

  const leads = await listProspectorLeads(limit, (lead) => {
    if (input.leadId && lead.id !== input.leadId) return false;
    return Boolean(lead.deployedSiteUrl) && Boolean(lead.prospectorVoiceVariables) && !lead.dnc;
  });

  let queued = 0;
  let skipped = 0;
  let failed = 0;
  const callIds: string[] = [];

  for (const lead of leads) {
    const toNumber = normalizePhone(lead.phone || "");
    if (!toNumber) {
      skipped += 1;
      await safeAppendRecord({
        leadId: lead.id,
        phase: 5,
        status: "skipped",
        message: "Skipped phase 5 call due to missing valid phone",
        company: lead.company,
        deployedSiteUrl: lead.deployedSiteUrl
      });
      continue;
    }

    if (assistantError) {
      skipped += 1;
      await safeAppendRecord({
        leadId: lead.id,
        phase: 5,
        status: "skipped",
        message: assistantError,
        company: lead.company,
        deployedSiteUrl: lead.deployedSiteUrl
      });
      continue;
    }

    if (dryRun) {
      skipped += 1;
      await safeAppendRecord({
        leadId: lead.id,
        phase: 5,
        status: "skipped",
        message: "Phase 5 dry-run: call not queued",
        company: lead.company,
        deployedSiteUrl: lead.deployedSiteUrl,
        payload: { assistantId }
      });
      continue;
    }

    try {
      const result = await createOutboundCall(
        { ...lead, phone: toNumber },
        {
          assistantId,
          additionalVariables: lead.prospectorVoiceVariables || {}
        }
      );

      await withState((state) => {
        const row = state.leads[lead.id];
        if (!row) return;
        row.status = "dialing";
        row.callId = result.id;
        row.callAttemptedAt = nowIso();
        row.lastAttemptAt = nowIso();
        row.attempts = Math.max(1, (row.attempts || 0) + 1);
        row.prospectorPhase = 5;
        row.prospectorPhaseStatus = "phase5_call_queued";
        row.prospectorCallAssistantId = assistantId;
        row.prospectorCalledAt = nowIso();
        row.updatedAt = nowIso();
      });

      queued += 1;
      callIds.push(result.id);
      await safeAppendRecord({
        leadId: lead.id,
        phase: 5,
        status: "success",
        message: "Phase 5 specialized call queued",
        company: lead.company,
        deployedSiteUrl: lead.deployedSiteUrl,
        payload: { callId: result.id, assistantId }
      });
    } catch (error) {
      failed += 1;
      await safeAppendRecord({
        leadId: lead.id,
        phase: 5,
        status: "error",
        message: "Phase 5 call queue failed",
        company: lead.company,
        deployedSiteUrl: lead.deployedSiteUrl,
        payload: { error: String(error).slice(0, 400), assistantId }
      });
    }
  }

  return { queued, skipped, failed, callIds, error: assistantError };
}

export async function runProspectorPipeline(input: ProspectorPipelineInput): Promise<ProspectorPipelineResult> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit || 10)));
  const runPhase1 = Boolean(input.runPhase1);
  const runPhase2 = input.runPhase2 !== false;
  const runPhase3 = input.runPhase3 !== false;
  const runPhase4 = input.runPhase4 !== false;
  const runPhase5 = Boolean(input.runPhase5);
  const out: ProspectorPipelineResult = {};
  const errors: Array<{ phase: 1 | 2 | 3 | 4 | 5; error: string }> = [];

  if (runPhase1) {
    const icp = (input.icp || "").trim();
    const city = (input.city || "").trim();
    const state = (input.state || "").trim();
    if (!icp || !city || !state) {
      errors.push({ phase: 1, error: "phase1 requires icp, city, and state" });
    } else {
      try {
        const run = await startProspectorRun({ icp, city, state });
        out.phase1 = { createdRunId: run.id, discovered: run.discovered };
      } catch (error) {
        errors.push({ phase: 1, error: String(error).slice(0, 600) });
      }
    }
  }

  if (runPhase2) {
    try {
      out.phase2 = await runProspectorPhase2(limit);
    } catch (error) {
      errors.push({ phase: 2, error: String(error).slice(0, 600) });
    }
  }
  if (runPhase3) {
    try {
      out.phase3 = await runProspectorPhase3(limit);
    } catch (error) {
      errors.push({ phase: 3, error: String(error).slice(0, 600) });
    }
  }
  if (runPhase4) {
    try {
      out.phase4 = await runProspectorPhase4(limit);
    } catch (error) {
      errors.push({ phase: 4, error: String(error).slice(0, 600) });
    }
  }
  if (runPhase5) {
    try {
      out.phase5 = await runProspectorPhase5({
        limit,
        dryRun: input.dryRunCalls,
        assistantId: input.assistantId
      });
    } catch (error) {
      errors.push({ phase: 5, error: String(error).slice(0, 600) });
    }
  }

  if (errors.length > 0) {
    out.errors = errors;
  }

  return out;
}
