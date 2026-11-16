/**
 * Reads a row list out of a Unity CLI listing envelope.
 *
 * Unity CLI 1.0.0 changed every listing to one shape:
 * `data: { items, total, nextPage, partial }`. Before that, some listings
 * returned a bare array and others used a named key (`editors`, `modules`,
 * `targets`). The toolkit supports the tested stable range, but keeping the
 * legacy shapes here costs one branch and makes the parser robust against a
 * command that still returns an old shape.
 */
export function listingRows(data: unknown, legacyKeys: readonly string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (typeof data !== 'object' || data === null) return [];

  const record = data as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items;
  for (const key of legacyKeys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}
