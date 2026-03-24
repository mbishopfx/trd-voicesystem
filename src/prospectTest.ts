import { withState } from './store.js';
import type { Lead } from './types.js';

export async function getProspectLeadById(leadId: string): Promise<Lead | undefined> {
  return withState((state) => {
    const lead = state.leads[leadId];
    return lead ? { ...lead } : undefined;
  });
}
