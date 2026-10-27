// Keyset cursor for article lists ordered by (sort_at DESC, id DESC). Opaque to the client:
// it just hands back whatever nextCursor the previous page returned.

export interface ArticleCursor {
  sortAt: string;
  id: number;
}

export function encodeCursor(sortAt: string, id: number): string {
  return `${sortAt}|${id}`;
}

export function decodeCursor(raw: string): ArticleCursor | null {
  const sep = raw.lastIndexOf("|");
  if (sep <= 0) return null;
  const sortAt = raw.slice(0, sep);
  const id = Number(raw.slice(sep + 1));
  if (!Number.isInteger(id) || id <= 0) return null;
  return { sortAt, id };
}
