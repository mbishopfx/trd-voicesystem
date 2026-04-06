import dotenv from "dotenv";
import path from "node:path";

const cwd = process.cwd();
dotenv.config();
dotenv.config({ path: path.resolve(cwd, ".env.local"), override: true });

function asInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function asFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(raw.trim().toLowerCase());
}

function asHourList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const values = raw
    .split(",")
    .map((chunk) => Number(chunk.trim()))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.min(23, Math.max(0, Math.trunc(value))));
  const unique = Array.from(new Set(values)).sort((a, b) => a - b);
  return unique.length ? unique : fallback;
}

function asStringList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const values = raw
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(values));
  return unique.length ? unique : fallback;
}

export const config = {
  port: asInt("PORT", 3000),
  databaseUrl:
    process.env.DATABASE_URL?.trim() ||
    process.env.SUPABASE_DATABASE_URL?.trim() ||
    process.env.SUPABASE_DIRECT_URL?.trim() ||
    "",
  webhookSecret: process.env.WEBHOOK_SECRET?.trim() || "",
  bookingUrl: process.env.BOOKING_URL?.trim() || "",
  bookingUrlCalendly: process.env.BOOKING_URL_CALENDLY?.trim() || "",
  bookingUrlGoogleCalendar: process.env.BOOKING_URL_GOOGLE_CALENDAR?.trim() || "",
  bookingProvider: process.env.BOOKING_PROVIDER?.trim().toLowerCase() || "calendly",

  dataDir: path.resolve(cwd, "data"),
  incomingDir: path.resolve(cwd, "data", "incoming"),
  processedDir: path.resolve(cwd, "data", "processed"),
  retargetDir: path.resolve(cwd, "data", "retarget"),
  statePath: path.resolve(cwd, "data", "state", "leads.json"),
  lockPath: path.resolve(cwd, "data", "state", "leads.lock"),
  templateStatePath: path.resolve(cwd, "data", "state", "templates.json"),
  templateLockPath: path.resolve(cwd, "data", "state", "templates.lock"),
  inboundStatePath: path.resolve(cwd, "data", "state", "inbound.json"),
  inboundLockPath: path.resolve(cwd, "data", "state", "inbound.lock"),
  voicesStatePath: path.resolve(cwd, "data", "state", "voices.json"),
  voicesLockPath: path.resolve(cwd, "data", "state", "voices.lock"),
  smsCampaignStatePath: path.resolve(cwd, "data", "state", "sms-campaigns.json"),
  smsCampaignLockPath: path.resolve(cwd, "data", "state", "sms-campaigns.lock"),
  bulkSchedulerStatePath: path.resolve(cwd, "data", "state", "bulk-scheduler.json"),
  bulkSchedulerLockPath: path.resolve(cwd, "data", "state", "bulk-scheduler.lock"),
  generatedSitesDir: path.resolve(cwd, "data", "generated-sites"),
  generatedScreenshotsDir: path.resolve(cwd, "data", "generated-screenshots"),

  campaignName: process.env.CAMPAIGN_NAME?.trim() || "Warm Lead Outreach",

  twilioCps: Math.max(0.1, asFloat("TWILIO_CPS", 1)),
  vapiCallCreateRps: Math.max(0.1, asFloat("VAPI_CALL_CREATE_RPS", 3)),
  systemCps: Math.max(0.1, asFloat("SYSTEM_CPS", 1)),
  maxConcurrentDials: Math.max(1, asInt("MAX_CONCURRENT_DIALS", 1)),

  maxAttempts: Math.max(1, asInt("MAX_ATTEMPTS", 3)),
  retryBaseSeconds: Math.max(1, asInt("RETRY_BASE_SECONDS", 30)),
  retryMaxSeconds: Math.max(5, asInt("RETRY_MAX_SECONDS", 900)),

  maxCallSeconds: Math.min(180, Math.max(15, asInt("MAX_CALL_SECONDS", 180))),
  postCallDelaySeconds: Math.max(0, asInt("POST_CALL_DELAY_SECONDS", 30)),
  requireOptIn: asBool("REQUIRE_OPT_IN", true),
  trustAllImports: asBool("TRUST_ALL_IMPORTS", true),
  defaultTimezone: process.env.DEFAULT_TIMEZONE?.trim() || "America/New_York",
  callWindowStartHour: Math.min(23, Math.max(0, asInt("CALL_WINDOW_START_HOUR", 9))),
  callWindowEndHour: Math.min(24, Math.max(1, asInt("CALL_WINDOW_END_HOUR", 18))),
  assistantWaitsForUser: asBool("ASSISTANT_WAITS_FOR_USER", false),
  voicemailDetectionProvider: process.env.VOICEMAIL_DETECTION_PROVIDER?.trim().toLowerCase() || "vapi",
  voicemailDetectionStartAtSeconds: Math.max(0, asFloat("VOICEMAIL_DETECTION_START_AT_SECONDS", 2)),
  voicemailDetectionFrequencySeconds: Math.max(2.5, asFloat("VOICEMAIL_DETECTION_FREQUENCY_SECONDS", 2.5)),
  voicemailDetectionMaxRetries: Math.max(1, asInt("VOICEMAIL_DETECTION_MAX_RETRIES", 6)),
  voicemailBeepMaxAwaitSeconds: Math.min(60, Math.max(0, asInt("VOICEMAIL_BEEP_MAX_AWAIT_SECONDS", 30))),

  runIngestOnStart: asBool("RUN_INGEST_ON_START", true),
  ingestIntervalHours: Math.max(1, asInt("INGEST_INTERVAL_HOURS", 24)),
  dialerTickMs: Math.max(100, asInt("DIALER_TICK_MS", 250)),
  reconcileIntervalSeconds: Math.max(15, asInt("RECONCILE_INTERVAL_SECONDS", 60)),
  reconcileMinAgeSeconds: Math.max(30, asInt("RECONCILE_MIN_AGE_SECONDS", 180)),
  bulkSchedulerEnabled: asBool("BULK_SCHEDULER_ENABLED", false),
  bulkSchedulerTimezone: process.env.BULK_SCHEDULER_TIMEZONE?.trim() || "America/New_York",
  bulkSchedulerHours: asHourList("BULK_SCHEDULER_HOURS", [9, 11, 14]),
  bulkSchedulerBatchSize: Math.max(1, Math.min(200, asInt("BULK_SCHEDULER_BATCH_SIZE", 50))),
  bulkSchedulerSamplePoolSize: Math.max(50, Math.min(2000, asInt("BULK_SCHEDULER_SAMPLE_POOL_SIZE", 400))),
  bulkSchedulerTickSeconds: Math.max(10, Math.min(300, asInt("BULK_SCHEDULER_TICK_SECONDS", 30))),
  bulkSchedulerRunWindowMinutes: Math.max(1, Math.min(15, asInt("BULK_SCHEDULER_RUN_WINDOW_MINUTES", 4))),
  bulkSchedulerCampaignName:
    process.env.BULK_SCHEDULER_CAMPAIGN_NAME?.trim() || "GHL Random Daily Campaign",
  prospectorAutoSchedulerEnabled: asBool("PROSPECTOR_AUTO_SCHEDULER_ENABLED", true),
  prospectorAutoSchedulerTimezone: process.env.PROSPECTOR_AUTO_SCHEDULER_TIMEZONE?.trim() || "America/New_York",
  prospectorAutoSchedulerHours: asHourList("PROSPECTOR_AUTO_SCHEDULER_HOURS", [9, 14]),
  prospectorAutoSchedulerTickSeconds: Math.max(10, Math.min(300, asInt("PROSPECTOR_AUTO_SCHEDULER_TICK_SECONDS", 30))),
  prospectorAutoSchedulerRunWindowMinutes: Math.max(
    1,
    Math.min(15, asInt("PROSPECTOR_AUTO_SCHEDULER_RUN_WINDOW_MINUTES", 5))
  ),
  prospectorAutoSchedulerIcpPool: asStringList("PROSPECTOR_AUTO_SCHEDULER_ICP_POOL", [
    "med spa",
    "roofing contractor",
    "plumber",
    "dental clinic",
    "real estate broker",
    "chiropractor",
    "personal injury law firm",
    "home remodeling contractor",
    "landscaping company",
    "HVAC contractor"
  ]),
  prospectorAutoSchedulerNjCities: asStringList("PROSPECTOR_AUTO_SCHEDULER_NJ_CITIES", [
    "Newark",
    "Jersey City",
    "Paterson",
    "Elizabeth",
    "Edison",
    "Woodbridge",
    "Lakewood",
    "Toms River",
    "Trenton",
    "Clifton",
    "Camden",
    "Hoboken"
  ]),

  vapiApiKey: process.env.VAPI_API_KEY?.trim() || "",
  vapiPublicKey: process.env.VAPI_PUBLIC_KEY?.trim() || "",
  vapiBaseUrl: process.env.VAPI_BASE_URL?.trim() || "https://api.vapi.ai",
  vapiCreditGuardEnabled: asBool("VAPI_CREDIT_GUARD_ENABLED", true),
  vapiMinCreditsToDial: Math.max(0, asFloat("VAPI_MIN_CREDITS_TO_DIAL", 1)),
  vapiCreditCheckIntervalSeconds: Math.max(10, Math.min(300, asInt("VAPI_CREDIT_CHECK_INTERVAL_SECONDS", 30))),
  vapiAssistantId: process.env.VAPI_ASSISTANT_ID?.trim() || "",
  vapiInboundAssistantId: process.env.VAPI_INBOUND_ASSISTANT_ID?.trim() || "",
  vapiAssistantIdFemale: process.env.VAPI_ASSISTANT_ID_FEMALE?.trim() || "",
  vapiAssistantIdMale: process.env.VAPI_ASSISTANT_ID_MALE?.trim() || "",
  vapiProspectorAssistantId: process.env.VAPI_PROSPECTOR_ASSISTANT_ID?.trim() || "",
  vapiPhoneNumberId: process.env.VAPI_PHONE_NUMBER_ID?.trim() || "",
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN?.trim() || "",
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER?.trim() || "",

  ghlApiKey: process.env.GHL_API_KEY?.trim() || "",
  ghlLocationId: process.env.GHL_LOCATION_ID?.trim() || "",
  ghlBaseUrl: process.env.GHL_BASE_URL?.trim() || "https://services.leadconnectorhq.com",
  ghlApiVersion: process.env.GHL_API_VERSION?.trim() || "2021-07-28",

  calendlyAccessToken: process.env.CALENDLY_ACCESS_TOKEN?.trim() || "",
  calendlyWebhookSigningKey: process.env.CALENDLY_WEBHOOK_SIGNING_KEY?.trim() || "",
  googleCalendarWebhookSecret: process.env.GOOGLE_CALENDAR_WEBHOOK_SECRET?.trim() || "",
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() || "",
  geminiModel: process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash",
  geminiProspectorModel: process.env.GEMINI_PROSPECTOR_MODEL?.trim() || "gemini-3.0-flash",
  xaiApiKey: process.env.XAI_API_KEY?.trim() || "",
  xaiBaseUrl: process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1",
  xaiModel: process.env.XAI_MODEL?.trim() || "grok-3-mini-beta",
  dataForSeoLogin: process.env.DATAFORSEO_LOGIN?.trim() || "",
  dataForSeoPassword: process.env.DATAFORSEO_PASSWORD?.trim() || "",
  apolloApiKey: process.env.APOLLO_API_KEY?.trim() || "",
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY?.trim() || "",
  firecrawlBaseUrl: process.env.FIRECRAWL_BASE_URL?.trim() || "https://api.firecrawl.dev",
  firecrawlTimeoutMs: Math.max(2000, asInt("FIRECRAWL_TIMEOUT_MS", 15000)),
  googleApiKey:
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GOOGLE_SEARCH_API_KEY?.trim() ||
    process.env.GOOGLE_MAPS_API_KEY?.trim() ||
    "",
  googleCseId:
    process.env.GOOGLE_CSE_ID?.trim() ||
    process.env.GOOGLE_SEARCH_ENGINE_ID?.trim() ||
    "",
  winSmsEnabled: asBool("WIN_SMS_ENABLED", true),
  winSmsTemplate:
    process.env.WIN_SMS_TEMPLATE?.trim() ||
    "Hi {{firstName}}, thanks for speaking with us. Book your free AI Search Optimization strategy session here: {{bookingUrl}}",
  prospectorWinSmsTemplate:
    process.env.PROSPECTOR_WIN_SMS_TEMPLATE?.trim() ||
    "Hi {{firstName}}, here is the live vision link: {{liveLink}}. If you want to move forward, book here: {{bookingUrl}}. A team member may reach out before the meeting.",
  smsCampaignDefaultTemplate:
    process.env.SMS_CAMPAIGN_DEFAULT_TEMPLATE?.trim() ||
    "hey [first_name], was just looking at [company_name]'s site and noticed something a little weird... u the owner?",
  smsCampaignReplyTemplate:
    process.env.SMS_CAMPAIGN_REPLY_TEMPLATE?.trim() ||
    "honestly nothing is actually broken, i just noticed [company_name] is basically invisible in google's new ai overviews around [city] while competitors are taking that traffic. usually that points to an authority or entity setup issue. are you handling seo in-house right now or do you have an agency on it?",
  smsCampaignDefaultMyName: process.env.SMS_CAMPAIGN_DEFAULT_MY_NAME?.trim() || "Jarvis",
  ghlSyncOnCallAttempt: asBool("GHL_SYNC_ON_CALL_ATTEMPT", false),
  prospectorGhlAutoSync: asBool("PROSPECTOR_GHL_AUTO_SYNC", true),
  retargetAutoExport: asBool("RETARGET_AUTO_EXPORT", true)
};

export function effectiveCps(): number {
  return Math.min(config.systemCps, config.twilioCps, config.vapiCallCreateRps);
}

export function resolvedBookingUrl(): string {
  if (config.bookingProvider === "google" && config.bookingUrlGoogleCalendar) {
    return config.bookingUrlGoogleCalendar;
  }
  if (config.bookingProvider === "calendly" && config.bookingUrlCalendly) {
    return config.bookingUrlCalendly;
  }
  return config.bookingUrl || config.bookingUrlCalendly || config.bookingUrlGoogleCalendar || "";
}
