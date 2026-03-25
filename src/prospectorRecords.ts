import { hasDatabaseState, withDbJsonState } from "./stateDb.js";
import { nowIso } from "./utils.js";

export interface ProspectorPhaseRecord {
  id: string;
  leadId: string;
  phase: 1 | 2 | 3 | 4 | 5;
  status: "success" | "skipped" | "error";
  message: string;
  company?: string;
  deployedSiteUrl?: string;
  generatedSitePath?: string;
  ghlContactId?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

interface ProspectorRecordState {
  records: ProspectorPhaseRecord[];
  updatedAt: string;
}

const STATE_KEY = "prospector_phase_records";
const MAX_RECORDS = 5000;

function createState(): ProspectorRecordState {
  return {
    records: [],
    updatedAt: nowIso()
  };
}

function toRecordId(leadId: string, phase: number, message: string): string {
  const seed = `${leadId}|${phase}|${message}|${Date.now()}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `pr-${Math.abs(hash).toString(36)}-${Date.now().toString(36)}`;
}

export function canWriteProspectorRecords(): boolean {
  return hasDatabaseState();
}

export async function appendProspectorPhaseRecord(
  input: Omit<ProspectorPhaseRecord, "id" | "createdAt">
): Promise<ProspectorPhaseRecord | undefined> {
  if (!hasDatabaseState()) return undefined;

  const record: ProspectorPhaseRecord = {
    ...input,
    id: toRecordId(input.leadId, input.phase, input.message),
    createdAt: nowIso()
  };

  await withDbJsonState<ProspectorRecordState, void>(STATE_KEY, createState, (state) => {
    state.records ??= [];
    state.records.unshift(record);
    if (state.records.length > MAX_RECORDS) {
      state.records.splice(MAX_RECORDS);
    }
  });

  return record;
}

export async function listProspectorPhaseRecords(limit = 200): Promise<ProspectorPhaseRecord[]> {
  if (!hasDatabaseState()) return [];
  let result: ProspectorPhaseRecord[] = [];
  await withDbJsonState<ProspectorRecordState, void>(STATE_KEY, createState, (state) => {
    state.records ??= [];
    result = state.records.slice(0, Math.max(1, Math.min(1000, Math.trunc(limit))));
  });
  return result;
}
