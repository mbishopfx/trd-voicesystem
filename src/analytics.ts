import type { Lead } from "./types.js";

export interface AnalyticsSummary {
  totals: {
    leads: number;
    attempted: number;
    queued: number;
    dialing: number;
    completed: number;
    booked: number;
    failed: number;
    blocked: number;
  };
  rates: {
    bookingRate: number;
    completionRate: number;
    failureRate: number;
  };
  byOutcome: Array<{ outcome: string; count: number }>;
  daily: Array<{ day: string; attempted: number; booked: number; completed: number }>;
  topCampaigns: Array<{ campaign: string; total: number; attempted: number; booked: number }>;
}

function dayKey(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

export function computeAnalyticsSummary(leads: Lead[]): AnalyticsSummary {
  const totals = {
    leads: leads.length,
    attempted: 0,
    queued: 0,
    dialing: 0,
    completed: 0,
    booked: 0,
    failed: 0,
    blocked: 0
  };

  const outcomeMap = new Map<string, number>();
  const dailyMap = new Map<string, { attempted: number; booked: number; completed: number }>();
  const campaignMap = new Map<string, { total: number; attempted: number; booked: number }>();

  for (const lead of leads) {
    if (lead.status === "queued") totals.queued += 1;
    if (lead.status === "dialing") totals.dialing += 1;
    if (lead.status === "completed") totals.completed += 1;
    if (lead.status === "booked") totals.booked += 1;
    if (lead.status === "failed") totals.failed += 1;
    if (lead.status === "blocked") totals.blocked += 1;

    const attempted = (lead.attempts || 0) > 0 || Boolean(lead.callAttemptedAt) || Boolean(lead.callId);
    if (attempted) totals.attempted += 1;

    const outcome = lead.outcome || "unknown";
    outcomeMap.set(outcome, (outcomeMap.get(outcome) || 0) + 1);

    const day = dayKey(lead.lastAttemptAt || lead.callAttemptedAt || lead.updatedAt);
    if (day) {
      const entry = dailyMap.get(day) || { attempted: 0, booked: 0, completed: 0 };
      if (attempted) entry.attempted += 1;
      if (lead.status === "booked") entry.booked += 1;
      if (lead.status === "completed" || lead.status === "booked") entry.completed += 1;
      dailyMap.set(day, entry);
    }

    const campaign = lead.campaign || "unknown";
    const c = campaignMap.get(campaign) || { total: 0, attempted: 0, booked: 0 };
    c.total += 1;
    if (attempted) c.attempted += 1;
    if (lead.status === "booked") c.booked += 1;
    campaignMap.set(campaign, c);
  }

  const byOutcome = [...outcomeMap.entries()]
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count);

  const daily = [...dailyMap.entries()]
    .map(([day, values]) => ({ day, ...values }))
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-14);

  const topCampaigns = [...campaignMap.entries()]
    .map(([campaign, values]) => ({ campaign, ...values }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return {
    totals,
    rates: {
      bookingRate: pct(totals.booked, totals.attempted),
      completionRate: pct(totals.completed + totals.booked, totals.attempted),
      failureRate: pct(totals.failed, totals.attempted)
    },
    byOutcome,
    daily,
    topCampaigns
  };
}
