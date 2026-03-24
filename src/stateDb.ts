import { Pool } from "pg";
import { config } from "./config.js";
import { nowIso } from "./utils.js";

let pool: Pool | undefined;
let schemaEnsured = false;
let databaseDisabled = false;

function hasLocalHost(connectionString: string): boolean {
  const lowered = connectionString.toLowerCase();
  return lowered.includes("localhost") || lowered.includes("127.0.0.1");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function hasDatabaseState(): boolean {
  return Boolean(config.databaseUrl) && !databaseDisabled;
}

export function disableDatabaseState(reason?: unknown): void {
  if (!config.databaseUrl || databaseDisabled) return;
  databaseDisabled = true;
  if (reason) {
    console.error("[STATE] Database state disabled for this process; falling back to filesystem state.", reason);
  } else {
    console.error("[STATE] Database state disabled for this process; falling back to filesystem state.");
  }
}

async function getPool(): Promise<Pool> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: hasLocalHost(config.databaseUrl) ? undefined : { rejectUnauthorized: false }
    });
  }

  return pool;
}

export async function ensureDbStateTable(): Promise<void> {
  if (!hasDatabaseState() || schemaEnsured) return;
  const p = await getPool();

  await p.query(`
    create table if not exists app_state (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);

  schemaEnsured = true;
}

export async function loadDbJsonState<T>(key: string, fallback: T): Promise<T> {
  await ensureDbStateTable();
  const p = await getPool();
  const result = await p.query<{ value: T }>("select value from app_state where key = $1 limit 1", [key]);
  if (result.rowCount && result.rows[0]?.value) {
    return result.rows[0].value;
  }
  return clone(fallback);
}

export async function saveDbJsonState<T>(key: string, state: T): Promise<void> {
  await ensureDbStateTable();
  const p = await getPool();
  await p.query(
    `
      insert into app_state (key, value, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (key)
      do update set value = excluded.value, updated_at = excluded.updated_at
    `,
    [key, JSON.stringify(state)]
  );
}

export async function withDbJsonState<T extends { updatedAt: string }, R>(
  key: string,
  createFallback: () => T,
  fn: (state: T) => Promise<R> | R
): Promise<R> {
  await ensureDbStateTable();
  const p = await getPool();
  const client = await p.connect();

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`app_state:${key}`]);

    const row = await client.query<{ value: T }>("select value from app_state where key = $1 for update", [key]);
    const state = row.rowCount && row.rows[0]?.value ? row.rows[0].value : createFallback();

    const result = await fn(state);
    state.updatedAt = nowIso();

    await client.query(
      `
        insert into app_state (key, value, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (key)
        do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      [key, JSON.stringify(state)]
    );

    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
