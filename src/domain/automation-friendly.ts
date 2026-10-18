// Plain-words versions of validation problems, for every automation screen. The schema's own messages for graph rules are already plain; the raw
// ones zod produces ("Too small: expected string to have >=1 characters") are mapped here by field and kind. Pure, no dependencies.

export interface RawIssue { path?: readonly PropertyKey[]; message?: string; code?: string; minimum?: unknown; maximum?: unknown; origin?: string }

const FIELD: Record<string, string> = {
  name: "the name", days: "the number of days", withinDays: "the number of days", withinWeeks: "the number of weeks", overPercent: "the percentage",
  minAmount: "the amount", amountMinor: "the amount", message: "the note", customerId: "the customer", weekday: "the day of the week",
  minSeverity: "the severity", severity: "the severity", tone: "the tone", scenario: "the what-if", shocks: "the what-if",
};

const RAW = /^(too small|too big|invalid|expected|unrecognized|required|number must|string must|array must)/i;
const num = (v: unknown) => (typeof v === "bigint" || typeof v === "number" ? String(v) : null);

/** One problem in plain words. */
export function friendlyIssue(i: RawIssue): string {
  const msg = i.message ?? "";
  if (msg && !RAW.test(msg) && i.code !== "unrecognized_keys") return msg;
  const field = [...(i.path ?? [])].reverse().find((p): p is string => typeof p === "string" && p in FIELD);
  const label = field ? FIELD[field] : "one of the settings";
  if (field === "name") return i.code === "too_big" ? "Keep the name to 80 characters or fewer." : "Give this automation a name.";
  if (field === "message") return "The note can be at most 200 characters, with no line breaks.";
  const lo = num(i.minimum);
  const hi = num(i.maximum);
  if (i.code === "too_small") return lo ? `Use ${label} of ${lo} or more.` : `Fill in ${label}.`;
  if (i.code === "too_big") return hi ? `Use ${label} of ${hi} or fewer.` : `${label[0].toUpperCase()}${label.slice(1)} is too large.`;
  if (i.code === "invalid_type") return `Fill in ${label}.`;
  if (field === "minAmount" || field === "amountMinor") return "Use a whole amount, for example 1000.";
  if (i.code === "unrecognized_keys") return "Something in this flow is not part of what automations can do.";
  if (field === "customerId") return "Choose a customer from the list.";
  return `Check ${label}.`;
}

/** Every distinct problem, in plain words, in order. Accepts a zod error's issues or the API's `issues` list. */
export function friendlyIssues(issues: readonly RawIssue[] | undefined | null): string[] {
  return [...new Set((issues ?? []).map(friendlyIssue))];
}

/** A whole API reply (`{ error, issues? }`) in plain words. */
export function friendlyReply(d: { error?: string; issues?: readonly RawIssue[] } | undefined | null): string {
  if (d?.issues?.length) return friendlyIssues(d.issues).join(" ");
  const e = d?.error ?? "";
  return !e || e === "Invalid request" || RAW.test(e) ? "That did not work. Check the highlighted settings and try again." : e;
}
