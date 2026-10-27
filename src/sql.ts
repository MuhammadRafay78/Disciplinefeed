// D1 rejects a statement with more than 100 bound parameters, so lists of ids go out in chunks.
export const MAX_IDS_PER_STATEMENT = 90;

export function chunk<T>(items: T[], size = MAX_IDS_PER_STATEMENT): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
