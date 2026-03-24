import { coerceString } from "./utils.js";

export function normalizePhone(raw: unknown): string | undefined {
  const value = coerceString(raw);
  if (!value) return undefined;

  const keepPlus = value.startsWith("+");
  const digits = value.replace(/\D/g, "");
  if (!digits) return undefined;

  if (keepPlus && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }

  return undefined;
}
