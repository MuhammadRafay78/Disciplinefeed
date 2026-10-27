// Turns the raw body-text window around a search match into a readable excerpt: whole words only,
// with an ellipsis on each side that was actually cut off.
export function shapeExcerpt(raw: string, start: number, textLength: number): string {
  const clippedStart = start > 1;
  const clippedEnd = start - 1 + raw.length < textLength;
  let text = raw;
  if (clippedStart) text = text.replace(/^\S*\s+/, "");
  if (clippedEnd) text = text.replace(/\s+\S*$/, "");
  return `${clippedStart ? "…" : ""}${text.trim()}${clippedEnd ? "…" : ""}`;
}
