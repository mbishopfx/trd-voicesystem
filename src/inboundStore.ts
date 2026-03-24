import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import {
  disableDatabaseState,
  hasDatabaseState,
  loadDbJsonState,
  saveDbJsonState,
  withDbJsonState
} from "./stateDb.js";

export interface InboundProfile {
  assistantId: string;
  phoneNumberId: string;
  bookingProvider: "calendly" | "google-calendar" | "none";
  bookingUrl: string;
  voiceProfile: "female" | "male";
  brandName: string;
  objective: string;
  maxCallSeconds: number;
  waitForUser: boolean;
  enabled: boolean;
  updatedAt: string;
}

interface InboundState {
  profile: InboundProfile;
  updatedAt: string;
}

export interface InboundPhase {
  id: string;
  name: string;
  status: "pending" | "ready";
  description: string;
  checks: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let dbFallbackWarned = false;
let memoryFallbackWarned = false;
let memoryState: InboundState | undefined;

function normalizeBookingProvider(value?: string): InboundProfile["bookingProvider"] {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "calendly") return "calendly";
  if (normalized === "google-calendar" || normalized === "google") return "google-calendar";
  return "none";
}

function normalizeVoiceProfile(value?: string): InboundProfile["voiceProfile"] {
  return (value || "").trim().toLowerCase() === "male" ? "male" : "female";
}

function clampCallSeconds(value: number | undefined): number {
  if (!Number.isFinite(value)) return 120;
  return Math.min(300, Math.max(30, Math.trunc(value as number)));
}

function createDefaultProfile(): InboundProfile {
  const bookingProvider =
    config.bookingProvider === "calendly"
      ? "calendly"
      : config.bookingProvider === "google"
      ? "google-calendar"
      : "none";
  const bookingUrl =
    bookingProvider === "calendly"
      ? config.bookingUrlCalendly || config.bookingUrl
      : bookingProvider === "google-calendar"
      ? config.bookingUrlGoogleCalendar || config.bookingUrl
      : "";

  return {
    assistantId: config.vapiInboundAssistantId || config.vapiAssistantId || "",
    phoneNumberId: config.vapiPhoneNumberId || "",
    bookingProvider,
    bookingUrl: bookingUrl || "",
    voiceProfile: "female",
    brandName: "True Rank Digital",
    objective: "Qualify inbound lead intent and offer a free strategy meeting.",
    maxCallSeconds: config.maxCallSeconds,
    waitForUser: true,
    enabled: false,
    updatedAt: nowIso()
  };
}

function normalizeProfile(input: Partial<InboundProfile>, previous?: InboundProfile): InboundProfile {
  const defaults = createDefaultProfile();
  const base = {
    ...defaults,
    ...(previous || {})
  };
  const assistantId = typeof input.assistantId === "string" ? input.assistantId.trim() : base.assistantId;
  const phoneNumberId = typeof input.phoneNumberId === "string" ? input.phoneNumberId.trim() : base.phoneNumberId;
  const bookingUrl = typeof input.bookingUrl === "string" ? input.bookingUrl.trim() : base.bookingUrl;
  const brandName = typeof input.brandName === "string" ? input.brandName.trim() : base.brandName;
  const objective = typeof input.objective === "string" ? input.objective.trim() : base.objective;
  const maxCallSeconds =
    typeof input.maxCallSeconds === "number" ? clampCallSeconds(input.maxCallSeconds) : base.maxCallSeconds;

  return {
    assistantId,
    phoneNumberId,
    bookingProvider: normalizeBookingProvider(input.bookingProvider || base.bookingProvider),
    bookingUrl,
    voiceProfile: normalizeVoiceProfile(input.voiceProfile || base.voiceProfile),
    brandName: brandName || base.brandName,
    objective: objective || base.objective,
    maxCallSeconds,
    waitForUser: typeof input.waitForUser === "boolean" ? input.waitForUser : base.waitForUser,
    enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled,
    updatedAt: nowIso()
  };
}

function createEmptyInboundState(): InboundState {
  return {
    profile: createDefaultProfile(),
    updatedAt: nowIso()
  };
}

function normalizeInboundState(state: InboundState): InboundState {
  state.profile = normalizeProfile(state.profile || {}, state.profile || createDefaultProfile());
  state.updatedAt = state.updatedAt || nowIso();
  return state;
}

function getMemoryState(): InboundState {
  if (!memoryState) {
    memoryState = createEmptyInboundState();
  }
  return clone(memoryState);
}

async function ensureStateFile(): Promise<void> {
  await fs.mkdir(path.dirname(config.inboundStatePath), { recursive: true });
  try {
    await fs.access(config.inboundStatePath);
  } catch {
    const fallback = createEmptyInboundState();
    await fs.writeFile(config.inboundStatePath, JSON.stringify(fallback, null, 2), "utf8");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    try {
      const handle = await fs.open(config.inboundLockPath, "wx");
      await handle.close();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Could not acquire inbound lock after ${timeoutMs}ms`);
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(config.inboundLockPath);
  } catch {
    // no-op
  }
}

export async function loadInboundState(): Promise<InboundState> {
  if (hasDatabaseState()) {
    try {
      const parsed = await loadDbJsonState<InboundState>("inbound_profile", createEmptyInboundState());
      const normalized = normalizeInboundState(parsed);
      return normalized;
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[INBOUND] Database unavailable; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  try {
    await ensureStateFile();
    const raw = await fs.readFile(config.inboundStatePath, "utf8");
    const parsed = normalizeInboundState(JSON.parse(raw) as InboundState);
    memoryState = clone(parsed);
    return parsed;
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[INBOUND] Filesystem unavailable; using in-memory state.", error);
      memoryFallbackWarned = true;
    }
    return getMemoryState();
  }
}

async function saveInboundState(state: InboundState): Promise<void> {
  state.updatedAt = nowIso();
  state.profile.updatedAt = nowIso();

  if (hasDatabaseState()) {
    try {
      await saveDbJsonState("inbound_profile", state);
      return;
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[INBOUND] Database save failed; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  try {
    const tempPath = `${config.inboundStatePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tempPath, config.inboundStatePath);
    memoryState = clone(state);
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[INBOUND] Filesystem save failed; using in-memory only.", error);
      memoryFallbackWarned = true;
    }
    memoryState = clone(state);
  }
}

export async function withInboundState<T>(fn: (state: InboundState) => Promise<T> | T): Promise<T> {
  if (hasDatabaseState()) {
    try {
      return withDbJsonState("inbound_profile", createEmptyInboundState, async (state) => {
        normalizeInboundState(state);
        return fn(state);
      });
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[INBOUND] Database transaction failed; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  let lockAcquired = false;
  try {
    await acquireLock();
    lockAcquired = true;
    const state = await loadInboundState();
    const result = await fn(state);
    await saveInboundState(state);
    return result;
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[INBOUND] Lock/filesystem unavailable; using in-memory state.", error);
      memoryFallbackWarned = true;
    }
    const state = getMemoryState();
    const result = await fn(state);
    state.updatedAt = nowIso();
    state.profile.updatedAt = nowIso();
    memoryState = clone(state);
    return result;
  } finally {
    if (lockAcquired) await releaseLock();
  }
}

export async function loadInboundProfile(): Promise<InboundProfile> {
  const state = await loadInboundState();
  return state.profile;
}

export async function saveInboundProfilePatch(patch: Partial<InboundProfile>): Promise<InboundProfile> {
  let updated: InboundProfile | undefined;
  await withInboundState((state) => {
    state.profile = normalizeProfile(patch, state.profile);
    updated = state.profile;
  });

  return updated || normalizeProfile(patch, createDefaultProfile());
}

export function inboundPhasePlan(profile: InboundProfile): InboundPhase[] {
  return [
    {
      id: "identity",
      name: "Inbound Identity",
      status: profile.brandName && profile.objective ? "ready" : "pending",
      description: "Define the brand voice and lead-handling objective.",
      checks: [`brandName=${profile.brandName || "missing"}`, `objective=${profile.objective ? "set" : "missing"}`]
    },
    {
      id: "assistant",
      name: "Assistant Binding",
      status: profile.assistantId ? "ready" : "pending",
      description: "Attach a Vapi assistant for inbound conversations.",
      checks: [`assistantId=${profile.assistantId || "missing"}`]
    },
    {
      id: "number",
      name: "Phone Number Routing",
      status: profile.phoneNumberId ? "ready" : "pending",
      description: "Bind an inbound phone number to the selected assistant.",
      checks: [`phoneNumberId=${profile.phoneNumberId || "missing"}`]
    },
    {
      id: "booking",
      name: "Booking Handoff",
      status: profile.bookingProvider !== "none" && profile.bookingUrl ? "ready" : "pending",
      description: "Configure booking provider and meeting URL for qualified leads.",
      checks: [
        `bookingProvider=${profile.bookingProvider}`,
        `bookingUrl=${profile.bookingUrl ? "set" : "missing"}`
      ]
    },
    {
      id: "runtime",
      name: "Runtime Guardrails",
      status: profile.maxCallSeconds <= 180 && profile.waitForUser ? "ready" : "pending",
      description: "Apply max call duration and user-first response guardrails.",
      checks: [
        `maxCallSeconds=${profile.maxCallSeconds}`,
        `waitForUser=${profile.waitForUser}`,
        `enabled=${profile.enabled}`
      ]
    }
  ];
}
