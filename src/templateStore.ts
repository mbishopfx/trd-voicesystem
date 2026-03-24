import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { AgentTemplate } from "./agentTemplates.js";
import { createDefaultTemplate, normalizeTemplateInput } from "./agentTemplates.js";
import {
  disableDatabaseState,
  hasDatabaseState,
  loadDbJsonState,
  saveDbJsonState,
  withDbJsonState
} from "./stateDb.js";

interface TemplateState {
  templates: Record<string, AgentTemplate>;
  activeTemplateId?: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

let dbFallbackWarned = false;
let memoryFallbackWarned = false;
let memoryState: TemplateState | undefined;

function createEmptyTemplateState(): TemplateState {
  return {
    templates: {},
    updatedAt: nowIso()
  };
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeTemplateState(parsed: TemplateState): TemplateState {
  parsed.templates ??= {};
  parsed.updatedAt ??= nowIso();

  for (const [id, template] of Object.entries(parsed.templates)) {
    parsed.templates[id] = normalizeTemplateInput(template as unknown as Record<string, unknown>, template);
  }

  const ids = Object.keys(parsed.templates);
  if (ids.length === 0) {
    const fallback = createDefaultTemplate();
    parsed.templates[fallback.id] = fallback;
    parsed.activeTemplateId = fallback.id;
  }

  if (!parsed.activeTemplateId || !parsed.templates[parsed.activeTemplateId]) {
    parsed.activeTemplateId = Object.keys(parsed.templates)[0];
  }

  return parsed;
}

function getMemoryState(): TemplateState {
  if (!memoryState) {
    memoryState = normalizeTemplateState(createEmptyTemplateState());
  }
  return cloneState(memoryState);
}

async function ensureStateFile(): Promise<void> {
  await fs.mkdir(path.dirname(config.templateStatePath), { recursive: true });
  try {
    await fs.access(config.templateStatePath);
  } catch {
    const fallback = createDefaultTemplate();
    const bootState: TemplateState = {
      templates: { [fallback.id]: fallback },
      activeTemplateId: fallback.id,
      updatedAt: nowIso()
    };
    await fs.writeFile(config.templateStatePath, JSON.stringify(bootState, null, 2));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    try {
      const handle = await fs.open(config.templateLockPath, "wx");
      await handle.close();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Could not acquire template lock after ${timeoutMs}ms`);
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(config.templateLockPath);
  } catch {
    // no-op
  }
}

export async function loadTemplateState(): Promise<TemplateState> {
  if (hasDatabaseState()) {
    try {
      const parsed = await loadDbJsonState<TemplateState>("templates", createEmptyTemplateState());
      parsed.templates ??= {};
      parsed.updatedAt ??= nowIso();

      let changed = false;
      for (const [id, template] of Object.entries(parsed.templates)) {
        const normalized = normalizeTemplateInput(template as unknown as Record<string, unknown>, template);
        parsed.templates[id] = normalized;
      }
      const ids = Object.keys(parsed.templates);
      if (ids.length === 0) {
        const fallback = createDefaultTemplate();
        parsed.templates[fallback.id] = fallback;
        parsed.activeTemplateId = fallback.id;
        changed = true;
      }

      if (!parsed.activeTemplateId || !parsed.templates[parsed.activeTemplateId]) {
        parsed.activeTemplateId = Object.keys(parsed.templates)[0];
        changed = true;
      }

      if (changed) {
        parsed.updatedAt = nowIso();
        await saveDbJsonState("templates", parsed);
      }

      return parsed;
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[TEMPLATES] Database unavailable; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  try {
    await ensureStateFile();
    const raw = await fs.readFile(config.templateStatePath, "utf8");
    const parsed = normalizeTemplateState(JSON.parse(raw) as TemplateState);
    memoryState = cloneState(parsed);
    return parsed;
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[TEMPLATES] Filesystem state unavailable; using in-memory template state.", error);
      memoryFallbackWarned = true;
    }
    return getMemoryState();
  }
}

export async function saveTemplateState(state: TemplateState): Promise<void> {
  if (hasDatabaseState()) {
    try {
      state.updatedAt = nowIso();
      await saveDbJsonState("templates", state);
      return;
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[TEMPLATES] Database save failed; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  try {
    state.updatedAt = nowIso();
    const tempPath = `${config.templateStatePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2));
    await fs.rename(tempPath, config.templateStatePath);
    memoryState = cloneState(state);
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[TEMPLATES] Filesystem save failed; using in-memory template state only.", error);
      memoryFallbackWarned = true;
    }
    state.updatedAt = nowIso();
    memoryState = cloneState(state);
  }
}

export async function withTemplateState<T>(fn: (state: TemplateState) => Promise<T> | T): Promise<T> {
  if (hasDatabaseState()) {
    try {
      return withDbJsonState("templates", createEmptyTemplateState, async (state) => {
        state.templates ??= {};
        state.updatedAt ??= nowIso();
        for (const [id, template] of Object.entries(state.templates)) {
          state.templates[id] = normalizeTemplateInput(template as unknown as Record<string, unknown>, template);
        }

        if (Object.keys(state.templates).length === 0) {
          const fallback = createDefaultTemplate();
          state.templates[fallback.id] = fallback;
          state.activeTemplateId = fallback.id;
        }

        if (!state.activeTemplateId || !state.templates[state.activeTemplateId]) {
          state.activeTemplateId = Object.keys(state.templates)[0];
        }

        return fn(state);
      });
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[TEMPLATES] Database transaction failed; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  let lockAcquired = false;
  try {
    await acquireLock();
    lockAcquired = true;
    const state = await loadTemplateState();
    const result = await fn(state);
    await saveTemplateState(state);
    return result;
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[TEMPLATES] Template lock/filesystem unavailable; using in-memory state.", error);
      memoryFallbackWarned = true;
    }
    const state = getMemoryState();
    const result = await fn(state);
    state.updatedAt = nowIso();
    memoryState = cloneState(state);
    return result;
  } finally {
    if (lockAcquired) {
      await releaseLock();
    }
  }
}
