import { withState } from './store.js';
import { nowIso } from './utils.js';

export async function releaseProspectToQueue(leadId: string): Promise<{ updated: boolean; reason?: string }> {
  return withState((state) => {
    const lead = state.leads[leadId];
    if (!lead) return { updated: false, reason: 'Lead not found' };
    if (lead.sourceFile !== 'prospector-dashboard') return { updated: false, reason: 'Not a prospector lead' };
    if (lead.handoffStatus !== 'ready_for_call') return { updated: false, reason: 'Lead is not ready for call' };
    lead.prospectAutoDialApproved = true;
    lead.handoffStatus = 'sent_to_queue';
    lead.status = 'queued';
    lead.updatedAt = nowIso();
    return { updated: true };
  });
}
