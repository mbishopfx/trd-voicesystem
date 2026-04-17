import { withState } from './store.js';
import { canMarkProspectReadyForCall, listProspectorBulkActionCandidates } from './prospectorReview.js';
import { nowIso } from './utils.js';

export async function markProspectReadyForCall(leadId: string): Promise<{ updated: boolean; reason?: string }> {
  return withState((state) => {
    const lead = state.leads[leadId];
    if (!lead) return { updated: false, reason: 'Lead not found' };
    if (lead.sourceFile !== 'prospector-dashboard') return { updated: false, reason: 'Not a prospector lead' };
    const readiness = canMarkProspectReadyForCall(lead);
    if (!readiness.ready) return { updated: false, reason: readiness.blockers[0] || 'Prospect is not ready for call' };
    lead.handoffStatus = 'ready_for_call';
    lead.prospectAutoDialApproved = false;
    lead.status = 'blocked';
    lead.updatedAt = nowIso();
    return { updated: true };
  });
}

export async function bulkMarkProspectsReadyForCall(input?: {
  leadIds?: string[];
  limit?: number;
}): Promise<{
  requested: number;
  updated: number;
  skipped: number;
  leadIds: string[];
  results: Array<{ leadId: string; updated: boolean; reason?: string }>;
}> {
  return withState((state) => {
    const selectedLeadIds =
      input?.leadIds && input.leadIds.length > 0
        ? Array.from(new Set(input.leadIds.map((leadId) => String(leadId || '').trim()).filter(Boolean)))
        : listProspectorBulkActionCandidates(
            Object.values(state.leads),
            'mark_ready_for_call',
            Math.max(1, Math.min(500, Math.trunc(input?.limit || 25)))
          ).map((item) => item.leadId);

    const results: Array<{ leadId: string; updated: boolean; reason?: string }> = [];
    for (const leadId of selectedLeadIds) {
      const lead = state.leads[leadId];
      if (!lead) {
        results.push({ leadId, updated: false, reason: 'Lead not found' });
        continue;
      }
      if (lead.sourceFile !== 'prospector-dashboard') {
        results.push({ leadId, updated: false, reason: 'Not a prospector lead' });
        continue;
      }
      const readiness = canMarkProspectReadyForCall(lead);
      if (!readiness.ready) {
        results.push({ leadId, updated: false, reason: readiness.blockers[0] || 'Prospect is not ready for call' });
        continue;
      }
      lead.handoffStatus = 'ready_for_call';
      lead.prospectAutoDialApproved = false;
      lead.status = 'blocked';
      lead.updatedAt = nowIso();
      results.push({ leadId, updated: true });
    }

    return {
      requested: selectedLeadIds.length,
      updated: results.filter((item) => item.updated).length,
      skipped: results.filter((item) => !item.updated).length,
      leadIds: results.filter((item) => item.updated).map((item) => item.leadId),
      results
    };
  });
}
