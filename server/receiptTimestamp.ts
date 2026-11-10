/** Return the exact persisted signing time, falling back only for legacy rows. */
export function getReceiptTimestamp(entry: { signedAt?: unknown; createdAt?: unknown }): string | null {
  if (entry.signedAt !== null && entry.signedAt !== undefined) {
    return typeof entry.signedAt === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(entry.signedAt) &&
      Number.isFinite(Date.parse(entry.signedAt)) ? entry.signedAt : null;
  }

  if (entry.createdAt === null || entry.createdAt === undefined) return null;
  const date = entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdAt as any);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function isReceiptIdQuery(query: string): boolean {
  return /^\d+$/.test(query) && Number.isSafeInteger(Number(query));
}
