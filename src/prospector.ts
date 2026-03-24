import { randomUUID } from 'node:crypto';
import { withState } from './store.js';
import { config } from './config.js';
import { nowIso } from './utils.js';
import { runtimeInfo } from './runtimeLogs.js';
import type { Lead } from './types.js';

export interface ProspectorRunInput {
  icp: string;
  city: string;
  state: string;
}

export interface ProspectorRun {
  id: string;
  icp: string;
  city: string;
  state: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  discovered: number;
  notes?: string;
}

const runs: ProspectorRun[] = [];

function slug(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

function buildLead(input: ProspectorRunInput, idx: number): Lead {
  const createdAt = nowIso();
  const id = `prospector-${slug(input.icp)}-${slug(input.city)}-${slug(input.state)}-${idx}`;
  return {
    id,
    phone: '',
    firstName: undefined,
    lastName: undefined,
    company: `${input.city} ${input.icp} Prospect ${idx}`,
    email: undefined,
    timezone: config.defaultTimezone,
    campaign: `Prospector ${input.icp} ${input.city} ${input.state}`,
    sourceFile: 'prospector-dashboard',
    sourceRow: idx,
    findings: `Prospected lead candidate for ${input.icp} in ${input.city}, ${input.state}. Needs live enrichment and qualification for website/demo generation flow.`,
    notes: 'Generated from dashboard prospector run',
    optIn: false,
    dnc: false,
    status: 'blocked',
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

export async function startProspectorRun(input: ProspectorRunInput): Promise<ProspectorRun> {
  const createdAt = nowIso();
  const run: ProspectorRun = {
    id: randomUUID(),
    icp: input.icp.trim(),
    city: input.city.trim(),
    state: input.state.trim(),
    status: 'running',
    createdAt,
    updatedAt: createdAt,
    discovered: 0,
    notes: 'Initial scaffold run created from dashboard.'
  };
  runs.unshift(run);

  const seeds = [1, 2, 3].map((idx) => buildLead(input, idx));
  await withState((state) => {
    for (const lead of seeds) {
      state.leads[lead.id] = lead;
    }
    state.updatedAt = nowIso();
    return state;
  });

  run.discovered = seeds.length;
  run.status = 'completed';
  run.updatedAt = nowIso();
  runtimeInfo('agent', 'prospector run completed', {
    runId: run.id,
    icp: run.icp,
    city: run.city,
    state: run.state,
    discovered: run.discovered
  });
  return run;
}

export function listProspectorRuns(): ProspectorRun[] {
  return [...runs];
}
