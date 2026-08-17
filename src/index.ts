import { Hono } from "hono";
import { addFeed, refreshAllFeeds, refreshFeed } from "./feeds";

interface Bindings {
  DB: D1Database;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/feeds", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM feeds ORDER BY added_at DESC").all();
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

app.delete("/api/feeds/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM articles WHERE feed_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM feeds WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

app.post("/api/feeds/:id/refresh", async (c) => {
  const id = Number(c.req.param("id"));
  const feed = await c.env.DB.prepare("SELECT id, url FROM feeds WHERE id = ?")
    .bind(id)
    .first<{ id: number; url: string }>();
  if (!feed) return c.json({ error: "Feed not found" }, 404);
  const result = await refreshFeed(c.env.DB, feed);
  return c.json(result);
});

app.post("/api/refresh", async (c) => {
  const result = await refreshAllFeeds(c.env.DB);
  return c.json(result);
});

app.get("/api/articles", async (c) => {
  const feedId = c.req.query("feed_id");
  const unread = c.req.query("unread");
  const savedOnly = c.req.query("saved");
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
  if (cursor) {
    conditions.push("a.id < ?");
    params.push(Number(cursor));
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT a.id, a.feed_id, a.title, a.url, a.author, a.published_at, a.summary, a.is_read, a.is_saved, a.progress, f.title AS feed_title
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    ${where}
    ORDER BY a.id DESC
    LIMIT ?
  `;
  params.push(limit + 1);

  const { results } = await c.env.DB.prepare(query).bind(...params).all<Record<string, unknown>>();
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const nextCursor = hasMore ? (page[page.length - 1] as { id: number }).id : null;
  return c.json({ articles: page, nextCursor });
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
  return c.json(article);
});

app.patch("/api/articles/:id/progress", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ progress?: number }>().catch(() => ({}) as { progress?: number });
  if (typeof body.progress !== "number" || Number.isNaN(body.progress)) {
    return c.json({ error: "progress must be a number between 0 and 1" }, 400);
  }
  const progress = Math.min(1, Math.max(0, body.progress));
  await c.env.DB.prepare("UPDATE articles SET progress = ? WHERE id = ?").bind(progress, id).run();
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
  const { results } = await c.env.DB.prepare("SELECT * FROM highlights ORDER BY id ASC").all();
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
    `INSERT INTO highlights (text, article_id, article_title, article_url, feed_title)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(text, body.articleId ?? null, body.articleTitle ?? null, body.articleUrl ?? null, body.feedTitle ?? null)
    .run();
  const id = Number(result.meta.last_row_id);
  const created = await c.env.DB.prepare("SELECT * FROM highlights WHERE id = ?").bind(id).first();
  return c.json(created, 201);
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

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(refreshAllFeeds(env.DB));
  },
};
