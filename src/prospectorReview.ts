import type { Lead } from "./types.js";

export interface ProspectorReadinessCheck {
  ready: boolean;
  blockers: string[];
}

export interface ProspectorReviewQueueItem {
  leadId: string;
  company: string;
  handoffStatus: string;
  status: string;
  priorityScore: number;
  blockers: string[];
  nextStep: string;
  hasGeneratedSite: boolean;
  hasScreenshot: boolean;
  hasDeploy: boolean;
  hasVoiceScript: boolean;
  prospectScore: number;
  prospectOpportunityScore: number;
  updatedAt: string;
}

export interface ProspectorReviewQueueSummary {
  total: number;
  readyForCall: number;
  readyForReview: number;
  blockedBySiteGeneration: number;
  blockedByScreenshot: number;
  blockedByDeploy: number;
  blockedByScript: number;
}

export type ProspectorBulkAction = "mark_ready_for_call" | "release_to_queue";

export interface ProspectorBulkActionCandidate {
  leadId: string;
  company: string;
  action: ProspectorBulkAction;
  priorityScore: number;
  blockers: string[];
  handoffStatus: string;
  updatedAt: string;
}

function asFiniteScore(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function hasPhone(lead: Lead): boolean {
  return Boolean(String(lead.phone || "").trim());
}

export function getProspectReadinessBlockers(lead: Lead): string[] {
  const blockers: string[] = [];
  if (!hasPhone(lead)) blockers.push("Missing phone number");
  if (!lead.generatedSitePath) blockers.push("Generate prospect site");
  if (!lead.generatedScreenshotPath) blockers.push("Generate prospect screenshot");
  if (!lead.deployedSiteUrl) blockers.push("Deploy generated site");
  if (!lead.prospectorVoiceScript) blockers.push("Create prospector voice script");
  return blockers;
}

export function canMarkProspectReadyForCall(lead: Lead): ProspectorReadinessCheck {
  const blockers = getProspectReadinessBlockers(lead);
  return {
    ready: blockers.length === 0,
    blockers
  };
}

export function canReleaseProspectToQueue(lead: Lead): ProspectorReadinessCheck {
  const blockers = getProspectReadinessBlockers(lead);
  if (lead.handoffStatus !== "ready_for_call") blockers.unshift("Lead is not marked ready for call");
  return {
    ready: blockers.length === 0,
    blockers
  };
}

function determineNextStep(lead: Lead, blockers: string[]): string {
  if (blockers.length > 0) return blockers[0];
  if (lead.handoffStatus === "ready_for_call") return "Release to dialer queue";
  if (lead.handoffStatus === "sent_to_queue") return "Monitor queued outreach";
  return "Mark ready for call";
}

function computePriorityScore(lead: Lead, blockers: string[]): number {
  let score = 0;
  score += asFiniteScore(lead.prospectOpportunityScore) * 0.45;
  score += asFiniteScore(lead.prospectScore) * 0.25;
  if (lead.generatedSitePath) score += 10;
  if (lead.generatedScreenshotPath) score += 8;
  if (lead.deployedSiteUrl) score += 12;
  if (lead.prospectorVoiceScript) score += 10;
  if (lead.handoffStatus === "ready_for_call") score += 10;
  if (lead.handoffStatus === "ready_for_review") score += 5;
  if (lead.ghlContactId || lead.prospectorGhlContactId) score += 4;
  if (lead.lastError) score -= 6;
  score -= blockers.length * 12;
  return Math.max(0, Math.round(score));
}

export function buildProspectorReviewQueue(leads: Lead[], limit = 50): ProspectorReviewQueueItem[] {
  return leads
    .filter((lead) => lead.sourceFile === "prospector-dashboard")
    .map((lead) => {
      const blockers = getProspectReadinessBlockers(lead);
      return {
        leadId: lead.id,
        company: lead.company || lead.id,
        handoffStatus: lead.handoffStatus || "draft",
        status: lead.status,
        priorityScore: computePriorityScore(lead, blockers),
        blockers,
        nextStep: determineNextStep(lead, blockers),
        hasGeneratedSite: Boolean(lead.generatedSitePath),
        hasScreenshot: Boolean(lead.generatedScreenshotPath),
        hasDeploy: Boolean(lead.deployedSiteUrl),
        hasVoiceScript: Boolean(lead.prospectorVoiceScript),
        prospectScore: asFiniteScore(lead.prospectScore),
        prospectOpportunityScore: asFiniteScore(lead.prospectOpportunityScore),
        updatedAt: lead.updatedAt
      };
    })
    .sort((a, b) => {
      if (a.blockers.length !== b.blockers.length) return a.blockers.length - b.blockers.length;
      if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
      return Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "");
    })
    .slice(0, Math.max(1, Math.min(500, Math.trunc(limit))));
}

export function summarizeProspectorReviewQueue(leads: Lead[]): ProspectorReviewQueueSummary {
  const queue = leads.filter((lead) => lead.sourceFile === "prospector-dashboard");
  let readyForCall = 0;
  let readyForReview = 0;
  let blockedBySiteGeneration = 0;
  let blockedByScreenshot = 0;
  let blockedByDeploy = 0;
  let blockedByScript = 0;

  for (const lead of queue) {
    if (lead.handoffStatus === "ready_for_call") readyForCall += 1;
    if (lead.handoffStatus === "ready_for_review") readyForReview += 1;
    if (!lead.generatedSitePath) blockedBySiteGeneration += 1;
    if (!lead.generatedScreenshotPath) blockedByScreenshot += 1;
    if (!lead.deployedSiteUrl) blockedByDeploy += 1;
    if (!lead.prospectorVoiceScript) blockedByScript += 1;
  }

  return {
    total: queue.length,
    readyForCall,
    readyForReview,
    blockedBySiteGeneration,
    blockedByScreenshot,
    blockedByDeploy,
    blockedByScript
  };
}

export function listProspectorBulkActionCandidates(
  leads: Lead[],
  action: ProspectorBulkAction,
  limit = 25
): ProspectorBulkActionCandidate[] {
  return leads
    .filter((lead) => lead.sourceFile === "prospector-dashboard")
    .map((lead) => {
      const readiness =
        action === "mark_ready_for_call" ? canMarkProspectReadyForCall(lead) : canReleaseProspectToQueue(lead);
      return {
        leadId: lead.id,
        company: lead.company || lead.id,
        action,
        priorityScore: computePriorityScore(lead, readiness.blockers),
        blockers: readiness.blockers,
        handoffStatus: lead.handoffStatus || "draft",
        updatedAt: lead.updatedAt
      };
    })
    .filter((candidate) => candidate.blockers.length === 0)
    .sort((a, b) => {
      if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
      return Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "");
    })
    .slice(0, Math.max(1, Math.min(500, Math.trunc(limit))));
}
