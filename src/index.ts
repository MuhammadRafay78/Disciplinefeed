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
import { sanitizeHtml } from "./parse";

interface Bindings {
  DB: D1Database;
}

const app = new Hono<{ Bindings: Bindings }>();

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
  const result = await refreshAllFeeds(c.env.DB);
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
  const term = search?.toLowerCase();
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
  const nextCursor = hasMore && !inProgress ? encodeCursor(last.sort_at, last.id) : null;
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
  const result = await c.env.DB.prepare(`UPDATE articles SET is_read = 1 WHERE ${conditions.join(" AND ")}`)
    .bind(...params)
    .run();
  return c.json({ marked: result.meta.changes });
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
  if (!article.is_read) {
    await c.env.DB.prepare("UPDATE articles SET is_read = 1 WHERE id = ?").bind(id).run();
  }
  // Re-sanitize on the way out too, so rows stored before a sanitizer fix are covered.
  if (typeof article.content_html === "string") {
    article.content_html = await sanitizeHtml(article.content_html);
  }
  return c.json(article);
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

app.get("/api/highlights", async (c) => {
  const articleId = c.req.query("article_id");
  const stmt = articleId
    ? c.env.DB.prepare("SELECT * FROM highlights WHERE article_id = ? ORDER BY position ASC, id ASC").bind(Number(articleId))
    : c.env.DB.prepare("SELECT * FROM highlights ORDER BY position ASC, id ASC");
  const { results } = await stmt.all();
  return c.json(results);
});

interface HighlightBody {
  text?: string;
  articleId?: number;
  articleTitle?: string;
  articleUrl?: string;
  feedTitle?: string;
}

app.post("/api/highlights", async (c) => {
  const body = await c.req.json<HighlightBody>().catch(() => ({}) as HighlightBody);
  const text = body.text?.trim();
  if (!text) return c.json({ error: "Text is required" }, 400);
  const result = await c.env.DB.prepare(
    `INSERT INTO highlights (text, article_id, article_title, article_url, feed_title, position)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM highlights))`,
  )
    .bind(text, body.articleId ?? null, body.articleTitle ?? null, body.articleUrl ?? null, body.feedTitle ?? null)
    .run();
  const id = Number(result.meta.last_row_id);
  const created = await c.env.DB.prepare("SELECT * FROM highlights WHERE id = ?").bind(id).first();
  return c.json(created, 201);
});

// Saves a hand-arranged My List order: ids listed first-to-last.
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

app.patch("/api/highlights/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
  const text = body.text?.trim();
  if (!text) return c.json({ error: "Text is required" }, 400);
  await c.env.DB.prepare("UPDATE highlights SET text = ? WHERE id = ?").bind(text, id).run();
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
