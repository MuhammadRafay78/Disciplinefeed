import { Hono } from "hono";
import {
  addFeed,
  backfillArticleText,
  FEED_REFRESH_COLUMNS,
  refreshAllFeeds,
  refreshFeed,
  type FeedToRefresh,
} from "./feeds";
import { likePattern, scoreArticle } from "./discover";
import { findSubstackPublicationsForTopic } from "./discoverSources";
import { buildOpml, type OpmlFeed } from "./opml";
import { decodeCursor, encodeCursor } from "./pagination";
import { shapeExcerpt } from "./search";
import { chunk, placeholders } from "./sql";
import {
  cleanScriptTitle,
  currentScriptId,
  insertHighlight,
  NOW_ISO_SQL,
  resolveScriptId,
  type HighlightFields,
} from "./scripts";
import { sanitizeHtml } from "./parse";

interface Bindings {
  DB: D1Database;
}

const app = new Hono<{ Bindings: Bindings }>();

// Something each migration since 0005 adds that the code relies on. Migrations are applied by hand,
// so the app checks for them and can tell the user exactly what's missing instead of failing oddly.
const REQUIRED_SCHEMA: Array<{ migration: string; table: string; column?: string }> = [
  { migration: "0005_sort_at_and_conditional_get.sql", table: "articles", column: "sort_at" },
  { migration: "0005_sort_at_and_conditional_get.sql", table: "feeds", column: "etag" },
  { migration: "0006_highlight_position.sql", table: "highlights", column: "position" },
  { migration: "0007_article_text.sql", table: "articles", column: "content_text" },
  { migration: "0008_reading_log.sql", table: "reading_log" },
  { migration: "0009_scripts.sql", table: "scripts" },
  { migration: "0009_scripts.sql", table: "highlights", column: "script_id" },
];

app.get("/api/health", async (c) => {
  const tables = [...new Set(REQUIRED_SCHEMA.map((r) => r.table))];
  const results = await c.env.DB.batch<{ name: string }>(
    tables.map((table) => c.env.DB.prepare(`PRAGMA table_info(${table})`)),
  );
  const columnsByTable = new Map(tables.map((table, i) => [table, new Set(results[i].results.map((r) => r.name))]));
  const missing = [
    ...new Set(
      REQUIRED_SCHEMA.filter(({ table, column }) => {
        const columns = columnsByTable.get(table)!;
        return column ? !columns.has(column) : columns.size === 0;
      }).map((r) => r.migration),
    ),
  ];
  return c.json({ ok: missing.length === 0, missingMigrations: missing });
});

app.get("/api/feeds", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.url, f.title, f.site_url, f.added_at, f.last_fetched_at, f.last_status,
       (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id AND a.is_read = 0) AS unread_count
     FROM feeds f
     ORDER BY f.added_at DESC`,
  ).all();
  return c.json(results);
});

app.post("/api/feeds", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string });
  const url = body.url?.trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return c.json({ error: "A valid feed URL is required" }, 400);
  }
  try {
    const result = await addFeed(c.env.DB, url);
    return c.json(result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add feed";
    if (message.includes("UNIQUE constraint")) {
      return c.json({ error: "This feed is already in your list" }, 409);
    }
    if (message.includes("HTTP 429")) {
      return c.json({ error: "The source is rate-limiting us right now — wait a moment and try again" }, 429);
    }
    return c.json({ error: message }, 422);
  }
});

app.get("/api/opml", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT title, url, site_url FROM feeds ORDER BY title COLLATE NOCASE",
  ).all<OpmlFeed>();
  return c.body(buildOpml(results), 200, {
    "Content-Type": "text/x-opml; charset=utf-8",
    "Content-Disposition": 'attachment; filename="disciplinefeed-subscriptions.opml"',
  });
});

app.delete("/api/feeds/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM articles WHERE feed_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM feeds WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

app.post("/api/feeds/:id/refresh", async (c) => {
  const id = Number(c.req.param("id"));
  const feed = await c.env.DB.prepare(`SELECT ${FEED_REFRESH_COLUMNS} FROM feeds WHERE id = ?`)
    .bind(id)
    .first<FeedToRefresh>();
  if (!feed) return c.json({ error: "Feed not found" }, 404);
  const result = await refreshFeed(c.env.DB, feed);
  return c.json(result);
});

app.post("/api/refresh", async (c) => {
  // A manual refresh also advances the text backfill, so a large library catches up faster.
  const [result] = await Promise.all([refreshAllFeeds(c.env.DB), backfillArticleText(c.env.DB)]);
  return c.json(result);
});

const SEARCH_EXCERPT_LEAD = 70;
const SEARCH_EXCERPT_LENGTH = 220;

const ARTICLE_LIST_COLUMNS =
  "a.id, a.feed_id, a.title, a.url, a.author, a.published_at, a.summary, a.is_read, a.is_saved, a.progress, a.sort_at, f.title AS feed_title";

app.get("/api/articles", async (c) => {
  const feedId = c.req.query("feed_id");
  const unread = c.req.query("unread");
  const savedOnly = c.req.query("saved");
  const inProgress = c.req.query("in_progress") === "true";
  const search = c.req.query("q")?.trim();
  const cursor = c.req.query("cursor");
  const limit = Math.min(Number(c.req.query("limit") ?? 30) || 30, 100);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (feedId) {
    conditions.push("a.feed_id = ?");
    params.push(Number(feedId));
  }
  if (unread === "true") conditions.push("a.is_read = 0");
  if (savedOnly === "true") conditions.push("a.is_saved = 1");
  if (inProgress) conditions.push("a.progress > 0.02 AND a.progress < 0.95");
  // Rows not yet backfilled have no content_text; until then their HTML stands in.
  if (search) {
    const pattern = likePattern(search);
    conditions.push(
      `(a.title LIKE ? ESCAPE '\\' OR a.summary LIKE ? ESCAPE '\\' OR a.author LIKE ? ESCAPE '\\'
        OR COALESCE(a.content_text, a.content_html) LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern, pattern, pattern, pattern);
  }
  if (cursor && !inProgress) {
    const decoded = decodeCursor(cursor);
    if (!decoded) return c.json({ error: "Invalid cursor" }, 400);
    conditions.push("(a.sort_at, a.id) < (?, ?)");
    params.push(decoded.sortAt, decoded.id);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderBy = inProgress ? "a.progress_updated_at DESC" : "a.sort_at DESC, a.id DESC";
  // For searches, also return the stretch of body text around the first match. SQLite's lower()
  // only folds ASCII, so positions in lower(text) and text line up.
  const windowStart = `max(1, instr(lower(a.content_text), ?) - ${SEARCH_EXCERPT_LEAD})`;
  const excerptColumns = search
    ? `, CASE WHEN instr(lower(a.content_text), ?) > 0
         THEN substr(a.content_text, ${windowStart}, ${SEARCH_EXCERPT_LENGTH}) END AS match_excerpt,
       ${windowStart} AS excerpt_start,
       length(a.content_text) AS text_length`
    : "";
  // Fold only A–Z, exactly like SQLite's lower(), so the term and lower(text) agree character for
  // character (JavaScript's toLowerCase would also fold non-ASCII letters SQLite leaves alone).
  const term = search?.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  const selectParams = term ? [term, term, term] : [];
  const query = `
    SELECT ${ARTICLE_LIST_COLUMNS}${excerptColumns}
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    ${where}
    ORDER BY ${orderBy}
    LIMIT ?
  `;
  params.push(limit + 1);

  type Row = Record<string, unknown> & {
    id: number;
    sort_at: string;
    match_excerpt?: string | null;
    excerpt_start?: number;
    text_length?: number;
  };
  const listStmt = c.env.DB.prepare(query).bind(...selectParams, ...params);
  // The first page also reports the newest article id that existed when the list was loaded,
  // so "mark all as read" can't sweep up articles a refresh delivered after the user looked.
  const [listResult, maxResult] = cursor
    ? [await listStmt.all<Row>(), null]
    : await c.env.DB.batch<Record<string, unknown>>([listStmt, c.env.DB.prepare("SELECT MAX(id) AS max_id FROM articles")]);
  const results = listResult.results as Row[];
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  if (search) {
    for (const row of page) {
      if (row.match_excerpt) row.match_excerpt = shapeExcerpt(row.match_excerpt, row.excerpt_start!, row.text_length!);
      delete row.excerpt_start;
      delete row.text_length;
    }
  }
  const last = page[page.length - 1];
  // A row without sort_at (written by the previous deploy, awaiting backfill) sorts last; treat it
  // as the end of the list rather than encode a cursor that can't be compared.
  const nextCursor = hasMore && !inProgress && last.sort_at ? encodeCursor(last.sort_at, last.id) : null;
  const maxId = maxResult ? ((maxResult.results[0]?.max_id as number | null) ?? 0) : undefined;
  return c.json({ articles: page, nextCursor, maxId });
});

app.post("/api/articles/mark-all-read", async (c) => {
  const body = await c.req
    .json<{ feedId?: number | null; maxId?: number }>()
    .catch(() => ({}) as { feedId?: number | null; maxId?: number });
  if (typeof body.maxId !== "number" || !Number.isFinite(body.maxId)) {
    return c.json({ error: "maxId is required" }, 400);
  }
  const conditions = ["is_read = 0", "id <= ?"];
  const params: unknown[] = [body.maxId];
  if (typeof body.feedId === "number") {
    conditions.push("feed_id = ?");
    params.push(body.feedId);
  }
  const { results } = await c.env.DB.prepare(
    `UPDATE articles SET is_read = 1 WHERE ${conditions.join(" AND ")} RETURNING id`,
  )
    .bind(...params)
    .all<{ id: number }>();
  // The ids let the client offer "Undo".
  return c.json({ marked: results.length, ids: results.map((r) => r.id) });
});

const MAX_IDS_PER_REQUEST = 10000;

app.post("/api/articles/mark-unread", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
  const ids = body.ids;
  if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id) && id > 0)) {
    return c.json({ error: "ids must be a list of article ids" }, 400);
  }
  if (ids.length > MAX_IDS_PER_REQUEST) return c.json({ error: "Too many articles at once" }, 400);
  const statements = chunk(ids).map((part) =>
    c.env.DB.prepare(`UPDATE articles SET is_read = 0 WHERE id IN (${placeholders(part.length)})`).bind(...part),
  );
  if (statements.length) await c.env.DB.batch(statements);
  return c.json({ ok: true });
});

app.get("/api/articles/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const article = await c.env.DB.prepare(
    `SELECT a.*, f.title AS feed_title, f.site_url AS feed_site_url
     FROM articles a JOIN feeds f ON f.id = a.feed_id
     WHERE a.id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!article) return c.json({ error: "Article not found" }, 404);
  const writes = [];
  if (!article.is_read) writes.push(c.env.DB.prepare("UPDATE articles SET is_read = 1 WHERE id = ?").bind(id));
  // The client sends its local date, since "today" for a streak depends on the reader's timezone.
  const day = c.req.query("day");
  const logsDay = day !== undefined && isCalendarDay(day);
  if (logsDay) writes.push(c.env.DB.prepare("INSERT OR IGNORE INTO reading_log (day, article_id) VALUES (?, ?)").bind(day, id));
  const results = writes.length ? await c.env.DB.batch(writes) : [];
  article.first_read_today = logsDay && results[results.length - 1].meta.changes > 0;
  // Re-sanitize on the way out too, so rows stored before a sanitizer fix are covered.
  if (typeof article.content_html === "string") {
    article.content_html = await sanitizeHtml(article.content_html);
  }
  return c.json(article);
});

// Round-trips through Date so impossible dates (which Date.parse rolls over, e.g. 02-31) fail.
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Articles opened per day over the last ~10 weeks, for the reading streak.
app.get("/api/stats/reading", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT day, COUNT(*) AS count FROM reading_log
     WHERE day >= date('now', '-70 days')
     GROUP BY day ORDER BY day`,
  ).all<{ day: string; count: number }>();
  return c.json({ days: results });
});

app.post("/api/articles/:id/read", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ read?: boolean }>().catch(() => ({}) as { read?: boolean });
  if (typeof body.read !== "boolean") return c.json({ error: "read must be true or false" }, 400);
  const result = await c.env.DB.prepare("UPDATE articles SET is_read = ? WHERE id = ?")
    .bind(body.read ? 1 : 0, id)
    .run();
  if (result.meta.changes === 0) return c.json({ error: "Article not found" }, 404);
  return c.json({ is_read: body.read });
});

app.patch("/api/articles/:id/progress", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ progress?: number }>().catch(() => ({}) as { progress?: number });
  if (typeof body.progress !== "number" || Number.isNaN(body.progress)) {
    return c.json({ error: "progress must be a number between 0 and 1" }, 400);
  }
  const progress = Math.min(1, Math.max(0, body.progress));
  await c.env.DB.prepare("UPDATE articles SET progress = ?, progress_updated_at = datetime('now') WHERE id = ?")
    .bind(progress, id)
    .run();
  return c.json({ ok: true, progress });
});

app.post("/api/articles/:id/save", async (c) => {
  const id = Number(c.req.param("id"));
  const article = await c.env.DB.prepare("SELECT is_saved FROM articles WHERE id = ?")
    .bind(id)
    .first<{ is_saved: number }>();
  if (!article) return c.json({ error: "Article not found" }, 404);
  const nextVal = article.is_saved ? 0 : 1;
  await c.env.DB.prepare("UPDATE articles SET is_saved = ? WHERE id = ?").bind(nextVal, id).run();
  return c.json({ is_saved: !!nextVal });
});

// --- Saved scripts ---

app.get("/api/scripts", async (c) => {
  const db = c.env.DB;
  const currentId = await currentScriptId(db);
  // Snippets written by the previous deploy (before scripts existed) have no script; adopt them.
  const [, listed] = await db.batch<Record<string, unknown>>([
    db.prepare("UPDATE highlights SET script_id = ? WHERE script_id IS NULL").bind(currentId),
    db.prepare(
      `SELECT s.id, s.title, s.created_at,
         (SELECT COUNT(*) FROM highlights h WHERE h.script_id = s.id) AS snippet_count
       FROM scripts s
       ORDER BY s.created_at DESC, s.id DESC`,
    ),
  ]);
  return c.json({ scripts: listed.results, currentId });
});

// Creates a script and makes it the current one.
app.post("/api/scripts", async (c) => {
  const body = await c.req.json<{ title?: unknown }>().catch(() => ({}) as { title?: unknown });
  const title = cleanScriptTitle(body.title) ?? "Untitled script";
  const created = await c.env.DB.prepare("INSERT INTO scripts (title) VALUES (?) RETURNING id, title, created_at")
    .bind(title)
    .first();
  return c.json({ ...created, snippet_count: 0 }, 201);
});

app.patch("/api/scripts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ title?: unknown }>().catch(() => ({}) as { title?: unknown });
  const title = cleanScriptTitle(body.title);
  if (!title) return c.json({ error: "A script needs a name" }, 400);
  const result = await c.env.DB.prepare("UPDATE scripts SET title = ? WHERE id = ?").bind(title, id).run();
  if (result.meta.changes === 0) return c.json({ error: "Script not found" }, 404);
  return c.json({ id, title });
});

app.post("/api/scripts/:id/select", async (c) => {
  const id = Number(c.req.param("id"));
  const result = await c.env.DB.prepare(`UPDATE scripts SET selected_at = ${NOW_ISO_SQL} WHERE id = ?`).bind(id).run();
  if (result.meta.changes === 0) return c.json({ error: "Script not found" }, 404);
  return c.json({ currentId: id });
});

// Copies a script and its snippets (e.g. to cut a shorter version) and makes the copy current.
app.post("/api/scripts/:id/duplicate", async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const source = await db.prepare("SELECT title FROM scripts WHERE id = ?").bind(id).first<{ title: string }>();
  if (!source) return c.json({ error: "Script not found" }, 404);
  const copy = await db
    .prepare("INSERT INTO scripts (title) VALUES (?) RETURNING id, title, created_at")
    .bind(cleanScriptTitle(`${source.title} (copy)`))
    .first<{ id: number }>();
  const result = await db
    .prepare(
      `INSERT INTO highlights (text, article_id, article_title, article_url, feed_title, script_id, position)
       SELECT text, article_id, article_title, article_url, feed_title, ?, position
       FROM highlights WHERE script_id = ?`,
    )
    .bind(copy!.id, id)
    .run();
  return c.json({ ...copy, snippet_count: result.meta.changes }, 201);
});

// Deletes a script with its snippets. The client keeps what it showed to offer Undo.
app.delete("/api/scripts/:id", async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const [, deleted] = await db.batch([
    db.prepare("DELETE FROM highlights WHERE script_id = ?").bind(id),
    db.prepare("DELETE FROM scripts WHERE id = ?").bind(id),
  ]);
  if (deleted.meta.changes === 0) return c.json({ error: "Script not found" }, 404);
  return c.json({ ok: true });
});

// --- Snippets (highlights) ---

// ?article_id= lists snippets saved from one article, across all scripts (for highlighting it in the
// reader); otherwise the snippets of ?script_id=, or of the current script.
app.get("/api/highlights", async (c) => {
  const db = c.env.DB;
  const articleId = c.req.query("article_id");
  if (articleId) {
    const { results } = await db
      .prepare("SELECT * FROM highlights WHERE article_id = ? ORDER BY position ASC, id ASC")
      .bind(Number(articleId))
      .all();
    return c.json(results);
  }
  const requested = Number(c.req.query("script_id"));
  const scriptId = await resolveScriptId(db, Number.isInteger(requested) && requested > 0 ? requested : undefined);
  const { results } = await db
    .prepare("SELECT * FROM highlights WHERE script_id = ? ORDER BY position ASC, id ASC")
    .bind(scriptId)
    .all();
  return c.json(results);
});

interface HighlightBody extends HighlightFields {
  text?: string;
  scriptId?: number;
}

app.post("/api/highlights", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<HighlightBody>().catch(() => ({}) as HighlightBody);
  const text = body.text?.trim();
  if (!text) return c.json({ error: "Text is required" }, 400);
  const scriptId = await resolveScriptId(db, body.scriptId);
  const result = await insertHighlight(db, scriptId, text, body).run();
  const created = await db
    .prepare(
      `SELECT h.*, s.title AS script_title FROM highlights h LEFT JOIN scripts s ON s.id = h.script_id
       WHERE h.id = ?`,
    )
    .bind(Number(result.meta.last_row_id))
    .first();
  return c.json(created, 201);
});

// Re-adds several snippets, in order, to a script (used to undo "Clear" and script deletion).
app.post("/api/highlights/bulk", async (c) => {
  const db = c.env.DB;
  type BulkBody = { items?: unknown; scriptId?: unknown };
  const body = await c.req.json<BulkBody>().catch(() => ({}) as BulkBody);
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 1000) {
    return c.json({ error: "items must be a list of 1–1000 snippets" }, 400);
  }
  const valid = items.filter(
    (item): item is HighlightBody & { text: string } =>
      typeof item === "object" && item !== null && typeof item.text === "string" && item.text.trim() !== "",
  );
  if (valid.length !== items.length) return c.json({ error: "Every snippet needs text" }, 400);
  const scriptId = await resolveScriptId(db, body.scriptId);
  await db.batch(valid.map((item) => insertHighlight(db, scriptId, item.text.trim(), item)));
  return c.json({ added: valid.length, scriptId }, 201);
});

// Clears the given snippets. Only ids the client showed are removed, so a snippet added meanwhile
// from another device survives; the client keeps what it showed to offer Undo.
app.delete("/api/highlights", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Number.isInteger(id) && id > 0)) {
    return c.json({ error: "ids must be a non-empty list of highlight ids" }, 400);
  }
  if (ids.length > MAX_IDS_PER_REQUEST) return c.json({ error: "Too many snippets at once" }, 400);
  await c.env.DB.batch(
    chunk(ids).map((part) =>
      c.env.DB.prepare(`DELETE FROM highlights WHERE id IN (${placeholders(part.length)})`).bind(...part),
    ),
  );
  return c.json({ removed: ids.length });
});

// Saves a hand-arranged script order: ids listed first-to-last.
app.put("/api/highlights/order", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Number.isInteger(id) && id > 0)) {
    return c.json({ error: "ids must be a non-empty list of highlight ids" }, 400);
  }
  if (ids.length > 1000) return c.json({ error: "Too many highlights to reorder at once" }, 400);
  await c.env.DB.batch(
    ids.map((id, index) => c.env.DB.prepare("UPDATE highlights SET position = ? WHERE id = ?").bind(index + 1, id)),
  );
  return c.json({ ok: true });
});

// Edits a snippet's text, or moves it to the end of another script.
app.patch("/api/highlights/:id", async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  type PatchBody = { text?: string; scriptId?: unknown };
  const body = await c.req.json<PatchBody>().catch(() => ({}) as PatchBody);
  if (body.scriptId !== undefined) {
    const target = await db
      .prepare("SELECT id, title FROM scripts WHERE id = ?")
      .bind(Number(body.scriptId))
      .first<{ id: number; title: string }>();
    if (!target) return c.json({ error: "Script not found" }, 404);
    await db
      .prepare(
        `UPDATE highlights SET script_id = ?,
           position = (SELECT COALESCE(MAX(position), 0) + 1 FROM highlights WHERE script_id = ?)
         WHERE id = ?`,
      )
      .bind(target.id, target.id, id)
      .run();
    return c.json({ ok: true, scriptId: target.id, scriptTitle: target.title });
  }
  const text = body.text?.trim();
  if (!text) return c.json({ error: "Text is required" }, 400);
  await db.prepare("UPDATE highlights SET text = ? WHERE id = ?").bind(text, id).run();
  return c.json({ ok: true });
});

app.delete("/api/highlights/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM highlights WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

app.get("/api/topics", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM topics ORDER BY created_at ASC").all();
  return c.json(results);
});

app.post("/api/topics", async (c) => {
  const body = await c.req.json<{ keyword?: string }>().catch(() => ({}) as { keyword?: string });
  const keyword = body.keyword?.trim().toLowerCase();
  if (!keyword) return c.json({ error: "A topic keyword is required" }, 400);
  try {
    const result = await c.env.DB.prepare("INSERT INTO topics (keyword) VALUES (?)").bind(keyword).run();
    const id = Number(result.meta.last_row_id);
    const created = await c.env.DB.prepare("SELECT * FROM topics WHERE id = ?").bind(id).first();
    return c.json(created, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add topic";
    if (message.includes("UNIQUE constraint")) {
      return c.json({ error: "You're already tracking this topic" }, 409);
    }
    return c.json({ error: message }, 422);
  }
});

app.delete("/api/topics/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM topics WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

app.get("/api/discover", async (c) => {
  const { results: topicRows } = await c.env.DB.prepare("SELECT keyword FROM topics").all<{ keyword: string }>();
  const keywords = topicRows.map((t) => t.keyword);
  if (keywords.length === 0) return c.json({ articles: [], topics: [] });

  const conditions = keywords.map(() => "(a.title LIKE ? ESCAPE '\\' OR a.summary LIKE ? ESCAPE '\\')");
  const params: unknown[] = [];
  for (const keyword of keywords) {
    const pattern = likePattern(keyword);
    params.push(pattern, pattern);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT ${ARTICLE_LIST_COLUMNS}
     FROM articles a
     JOIN feeds f ON f.id = a.feed_id
     WHERE ${conditions.join(" OR ")}
     ORDER BY a.sort_at DESC, a.id DESC
     LIMIT 400`,
  )
    .bind(...params)
    .all<{ id: number; title: string; summary: string | null }>();

  const ranked = results
    .map((article) => ({ ...article, score: scoreArticle(article, keywords) }))
    .filter((article) => article.score > 0)
    .sort((a, b) => b.score - a.score || b.id - a.id)
    .slice(0, 50);

  return c.json({ articles: ranked, topics: keywords });
});

app.get("/api/discover/sources", async (c) => {
  const topic = c.req.query("topic")?.trim();
  if (!topic) return c.json({ error: "A topic is required" }, 400);

  try {
    const found = await findSubstackPublicationsForTopic(topic);
    const { results: existing } = await c.env.DB.prepare("SELECT url FROM feeds").all<{ url: string }>();
    const existingHosts = new Set(
      existing.map((f) => {
        try {
          return new URL(f.url).host.replace(/^www\./, "");
        } catch {
          return f.url;
        }
      }),
    );
    const sources = found.filter((s) => !existingHosts.has(new URL(s.feedUrl).host.replace(/^www\./, "")));
    return c.json({ topic, sources });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Substack search failed";
    return c.json({ error: message }, 502);
  }
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([refreshAllFeeds(env.DB), backfillArticleText(env.DB)]));
  },
};
