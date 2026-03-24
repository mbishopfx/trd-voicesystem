import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hashShort(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 16);
}

export function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "opted_in", "consented", "warm"].includes(normalized);
}

export function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function firstDefined(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    const coerced = coerceString(value);
    if (coerced) return coerced;
  }
  return undefined;
}

export function isMainModule(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(metaUrl) === process.argv[1];
}
