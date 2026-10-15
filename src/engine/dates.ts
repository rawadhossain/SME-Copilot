// Date-only helpers on ISO strings (YYYY-MM-DD). Everything is computed in UTC on whole days, so there
// are no timezone or daylight-saving shifts. No clock access.
const MS_DAY = 86_400_000;

export const toMs = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
export const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number): string => fromMs(toMs(iso) + n * MS_DAY);
/** b - a in whole days. */
export const diffDays = (a: string, b: string): number => Math.round((toMs(b) - toMs(a)) / MS_DAY);

/** Add calendar months, keeping the day of month where possible and clamping to month end (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1;
  const d = Number(iso.slice(8, 10));
  const total = y * 12 + m + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return fromMs(Date.UTC(ny, nm, Math.min(d, last)));
}

/** Lower median of integers (for an even count, the smaller of the two middle values). */
export function medianInt(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty list");
  const s = [...values].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}
