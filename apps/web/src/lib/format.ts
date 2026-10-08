import { getLocale } from "../paraglide/runtime.js";

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
    d,
  );
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" }).format(d);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/**
 * A byte count in the reader's locale (E2.8): binary multiples, named by `Intl`'s own unit
 * words ("5 kB", "1.2 MB") rather than an English suffix. `null` is unknown, not zero.
 */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const [unit, value, digits] =
    n < 1024
      ? (["byte", n, 0] as const)
      : n < 1024 ** 2
        ? (["kilobyte", n / 1024, 0] as const)
        : n < 1024 ** 3
          ? (["megabyte", n / 1024 ** 2, 1] as const)
          : (["gigabyte", n / 1024 ** 3, 2] as const);
  return new Intl.NumberFormat(getLocale(), {
    style: "unit",
    unit,
    unitDisplay: "short",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}
