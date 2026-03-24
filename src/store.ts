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
import type { State } from "./types.js";
import { nowIso, sleep } from "./utils.js";

let dbFallbackWarned = false;
let memoryFallbackWarned = false;
let memoryState: State | undefined;

function createEmptyState(): State {
  return {
    leads: {},
    filesProcessed: [],
    updatedAt: nowIso()
  };
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getMemoryState(): State {
  if (!memoryState) {
    memoryState = createEmptyState();
  }
  return cloneState(memoryState);
}

async function ensureStateFile(): Promise<void> {
  await fs.mkdir(path.dirname(config.statePath), { recursive: true });
  try {
    await fs.access(config.statePath);
  } catch {
    await fs.writeFile(config.statePath, JSON.stringify(createEmptyState(), null, 2));
  }
}

async function acquireLock(timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    try {
      const handle = await fs.open(config.lockPath, "wx");
      await handle.close();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Could not acquire state lock after ${timeoutMs}ms`);
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(config.lockPath);
  } catch {
    // Lock may already be gone; no action needed.
  }
}

export async function loadState(): Promise<State> {
  if (hasDatabaseState()) {
    try {
      const loaded = await loadDbJsonState<State>("leads", createEmptyState());
      loaded.leads ??= {};
      loaded.filesProcessed ??= [];
      loaded.updatedAt ??= nowIso();
      return loaded;
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[STATE] Database unavailable; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  try {
    await ensureStateFile();
    const raw = await fs.readFile(config.statePath, "utf8");
    const parsed = JSON.parse(raw) as State;
    parsed.leads ??= {};
    parsed.filesProcessed ??= [];
    parsed.updatedAt ??= nowIso();
    memoryState = cloneState(parsed);
    return parsed;
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[STATE] Filesystem state unavailable; falling back to in-memory state.", error);
      memoryFallbackWarned = true;
    }
    return getMemoryState();
  }
}

export async function saveState(state: State): Promise<void> {
  if (hasDatabaseState()) {
    try {
      state.updatedAt = nowIso();
      await saveDbJsonState("leads", state);
      return;
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[STATE] Database save failed; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  try {
    state.updatedAt = nowIso();
    const tempPath = `${config.statePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2));
    await fs.rename(tempPath, config.statePath);
    memoryState = cloneState(state);
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[STATE] Filesystem save failed; using in-memory state only.", error);
      memoryFallbackWarned = true;
    }
    state.updatedAt = nowIso();
    memoryState = cloneState(state);
  }
}

export async function withState<T>(fn: (state: State) => Promise<T> | T): Promise<T> {
  if (hasDatabaseState()) {
    try {
      return withDbJsonState("leads", createEmptyState, async (state) => {
        state.leads ??= {};
        state.filesProcessed ??= [];
        state.updatedAt ??= nowIso();
        return fn(state);
      });
    } catch (error) {
      if (!dbFallbackWarned) {
        console.error("[STATE] Database state transaction failed; falling back to filesystem state.", error);
        dbFallbackWarned = true;
      }
      disableDatabaseState();
    }
  }

  let lockAcquired = false;
  try {
    await acquireLock();
    lockAcquired = true;
    const state = await loadState();
    const result = await fn(state);
    await saveState(state);
    return result;
  } catch (error) {
    if (!memoryFallbackWarned) {
      console.error("[STATE] State lock/filesystem unavailable; using in-memory state.", error);
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
