import { withState } from './store.js';
import { nowIso } from './utils.js';

export async function markProspectReadyForCall(leadId: string): Promise<{ updated: boolean; reason?: string }> {
  return withState((state) => {
    const lead = state.leads[leadId];
    if (!lead) return { updated: false, reason: 'Lead not found' };
    if (lead.sourceFile !== 'prospector-dashboard') return { updated: false, reason: 'Not a prospector lead' };
    if (!lead.generatedSitePath) return { updated: false, reason: 'Generate site first' };
    if (!lead.generatedScreenshotPath) return { updated: false, reason: 'Generate screenshot first' };
    lead.handoffStatus = 'ready_for_call';
    lead.prospectAutoDialApproved = false;
    lead.status = 'blocked';
    lead.updatedAt = nowIso();
    return { updated: true };
  });
}
