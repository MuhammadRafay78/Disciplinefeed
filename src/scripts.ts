// Saved scripts: each is an ordered list of highlights (snippets). New snippets go to the most
// recently selected script, tracked server-side so every device agrees on where they land.

export const DEFAULT_SCRIPT_TITLE = "My List";
export const MAX_SCRIPT_TITLE_LENGTH = 80;

export const NOW_ISO_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export function cleanScriptTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const cleaned = title.replace(/\s+/g, " ").trim().slice(0, MAX_SCRIPT_TITLE_LENGTH);
  return cleaned || null;
}

// The script new snippets go to. There is always at least one; a fresh database gets "My List".
export async function currentScriptId(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT id FROM scripts ORDER BY selected_at DESC, id DESC LIMIT 1")
    .first<{ id: number }>();
  if (row) return row.id;
  const created = await db
    .prepare("INSERT INTO scripts (title) VALUES (?) RETURNING id")
    .bind(DEFAULT_SCRIPT_TITLE)
    .first<{ id: number }>();
  return created!.id;
}

// A script id from a request if it still exists (it may have been deleted on another device),
// otherwise the current script.
export async function resolveScriptId(db: D1Database, requested: unknown): Promise<number> {
  if (typeof requested === "number" && Number.isInteger(requested) && requested > 0) {
    const row = await db.prepare("SELECT id FROM scripts WHERE id = ?").bind(requested).first();
    if (row) return requested;
  }
  return currentScriptId(db);
}

export interface HighlightFields {
  articleId?: number | null;
  articleTitle?: string | null;
  articleUrl?: string | null;
  feedTitle?: string | null;
}

// Appends a snippet to the end of a script.
export function insertHighlight(db: D1Database, scriptId: number, text: string, fields: HighlightFields) {
  return db
    .prepare(
      `INSERT INTO highlights (text, article_id, article_title, article_url, feed_title, script_id, position)
       VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM highlights WHERE script_id = ?))`,
    )
    .bind(
      text,
      fields.articleId ?? null,
      fields.articleTitle ?? null,
      fields.articleUrl ?? null,
      fields.feedTitle ?? null,
      scriptId,
      scriptId,
    );
}
