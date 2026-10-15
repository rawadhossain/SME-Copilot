// Canonical JSON: keys sorted recursively, no whitespace. Used for hashing and signing so the same data always
// produces the same bytes. bigint becomes a decimal string; undefined fields are dropped.
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortValue(x);
    }
    return out;
  }
  return v;
}
