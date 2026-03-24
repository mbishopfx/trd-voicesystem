export type LeadStatus =
  | "queued"
  | "dialing"
  | "retry"
  | "completed"
  | "booked"
  | "failed"
  | "blocked";

export interface Lead {
  id: string;
  phone: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  email?: string;
  timezone: string;
  campaign: string;
  sourceFile: string;
  sourceRow: number;
  findings?: string;
  notes?: string;
  prospectAddress?: string;
  prospectGoogleMapsUri?: string;
  prospectWebsiteUri?: string;
  prospectWebsiteStatus?: 'missing' | 'present' | 'unknown';
  prospectIcp?: string;
  prospectCity?: string;
  prospectState?: string;
  prospectSummary?: string;
  generationStatus?: 'not_started' | 'ready' | 'generated' | 'deployed';
  generatedSitePath?: string;
  generatedScreenshotPath?: string;
  deployedSiteUrl?: string;
  handoffStatus?: 'draft' | 'ready_for_review' | 'ready_for_call' | 'sent_to_queue';
  prospectAutoDialApproved?: boolean;
  optIn: boolean;
  dnc: boolean;
  status: LeadStatus;
  attempts: number;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  callId?: string;
  callAttemptedAt?: string;
  callEndedAt?: string;
  outcome?: string;
  transcript?: string;
  transcriptSummary?: string;
  recordingUrl?: string;
  retargetBucket?: string;
  retargetReason?: string;
  retargetReadyAt?: string;
  bookedAt?: string;
  bookingSource?: string;
  winSmsSentAt?: string;
  winSmsError?: string;
  ghlContactId?: string;
  ghlSyncedAt?: string;
  ghlLastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface State {
  leads: Record<string, Lead>;
  filesProcessed: string[];
  updatedAt: string;
}

export interface IngestSummary {
  file: string;
  rows: number;
  accepted: number;
  blocked: number;
  duplicates: number;
  invalid: number;
}

export interface VapiCallResult {
  id: string;
  raw: Record<string, unknown>;
}

export interface ProspectorLeadRequest {
  icp: string;
  city: string;
  state: string;
}
