import { parseFeed, sanitizeHtml, type ParsedArticle } from "./parse";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
};

const MAX_FETCH_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CacheValidators {
  etag: string | null;
  lastModified: string | null;
}

type FeedFetch = { notModified: true } | { notModified: false; body: string; finalUrl: string; validators: CacheValidators };

async function fetchFeedXml(url: string, validators?: CacheValidators): Promise<FeedFetch> {
  const headers: Record<string, string> = { ...FETCH_HEADERS };
  if (validators?.etag) headers["If-None-Match"] = validators.etag;
  if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 304) return { notModified: true };
    if (res.ok) {
      return {
        notModified: false,
        body: await res.text(),
        finalUrl: res.url || url,
        validators: { etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") },
      };
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_FETCH_ATTEMPTS) {
      throw new Error(`HTTP ${res.status} fetching feed`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
    await sleep(delayMs);
  }
  throw new Error("Failed to fetch feed");
}

// Unconditional fetch (no validators sent), so a 304 can't happen; narrows the result type.
async function fetchFeedXmlFresh(url: string) {
  const result = await fetchFeedXml(url);
  if (result.notModified) throw new Error("Unexpected 304 fetching feed");
  return result;
}

const FEED_LINK_TYPES = ["application/rss+xml", "application/atom+xml"];

async function discoverFeedUrl(html: string, pageUrl: string): Promise<string | null> {
  let found: string | null = null;
  const rewriter = new HTMLRewriter().on("link", {
    element(el) {
      if (found) return;
      const rel = (el.getAttribute("rel") ?? "").toLowerCase();
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      const href = el.getAttribute("href");
      if (rel === "alternate" && href && FEED_LINK_TYPES.includes(type)) {
        found = href;
      }
    },
  });
  await rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  if (!found) return null;
  try {
    const resolved = new URL(found, pageUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.toString() === pageUrl ? null : resolved.toString();
  } catch {
    return null;
  }
}

async function fetchAndParseFeed(
  url: string,
): Promise<{ feedUrl: string; parsed: ReturnType<typeof parseFeed>; validators: CacheValidators }> {
  const { body, finalUrl, validators } = await fetchFeedXmlFresh(url);
  try {
    return { feedUrl: finalUrl, parsed: parseFeed(body), validators };
  } catch (err) {
    const discovered = await discoverFeedUrl(body, finalUrl);
    if (!discovered) throw err;
    const fetched = await fetchFeedXmlFresh(discovered);
    return { feedUrl: fetched.finalUrl, parsed: parseFeed(fetched.body), validators: fetched.validators };
  }
}

async function upsertArticles(db: D1Database, feedId: number, articles: ParsedArticle[]): Promise<number> {
  // Most refreshes re-deliver articles we already have; skip them up front rather than
  // sanitizing every body only for the INSERT to be ignored.
  const { results: existing } = await db
    .prepare("SELECT guid FROM articles WHERE feed_id = ?")
    .bind(feedId)
    .all<{ guid: string }>();
  const known = new Set(existing.map((r) => r.guid));
  const fresh = articles.filter((a) => a.url && !known.has(a.guid));
  if (fresh.length === 0) return 0;

  const statements = await Promise.all(
    fresh.map(async (article) => {
      const contentHtml = article.contentHtml ? await sanitizeHtml(article.contentHtml) : null;
      return db
        .prepare(
          `INSERT INTO articles (feed_id, guid, title, url, author, published_at, summary, content_html, sort_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(feed_id, guid) DO NOTHING`,
        )
        .bind(
          feedId,
          article.guid,
          article.title,
          article.url,
          article.author ?? null,
          article.publishedAt ?? null,
          article.summary ?? null,
          contentHtml,
          article.sortAt,
        );
    }),
  );

  const results = await db.batch(statements);
  return results.reduce((count, r) => count + (r.meta.changes > 0 ? 1 : 0), 0);
}

export async function addFeed(db: D1Database, inputUrl: string) {
  const { feedUrl, parsed, validators } = await fetchAndParseFeed(inputUrl);

  const insertFeed = await db
    .prepare(
      `INSERT INTO feeds (url, title, site_url, last_fetched_at, last_status, etag, last_modified)
       VALUES (?, ?, ?, datetime('now'), 'ok', ?, ?)`,
    )
    .bind(feedUrl, parsed.title, parsed.siteUrl ?? null, validators.etag, validators.lastModified)
    .run();
  const feedId = Number(insertFeed.meta.last_row_id);

  const newArticles = await upsertArticles(db, feedId, parsed.articles);
  return { feedId, title: parsed.title, newArticles };
}

export interface FeedToRefresh {
  id: number;
  url: string;
  etag: string | null;
  last_modified: string | null;
}

export const FEED_REFRESH_COLUMNS = "id, url, etag, last_modified";

export async function refreshFeed(db: D1Database, feed: FeedToRefresh) {
  try {
    const fetched = await fetchFeedXml(feed.url, { etag: feed.etag, lastModified: feed.last_modified });
    if (fetched.notModified) {
      await db
        .prepare(`UPDATE feeds SET last_fetched_at = datetime('now'), last_status = 'ok' WHERE id = ?`)
        .bind(feed.id)
        .run();
      return { newArticles: 0, error: undefined as string | undefined };
    }
    const parsed = parseFeed(fetched.body);
    const newArticles = await upsertArticles(db, feed.id, parsed.articles);
    await db
      .prepare(
        `UPDATE feeds SET last_fetched_at = datetime('now'), last_status = 'ok', etag = ?, last_modified = ?
         WHERE id = ?`,
      )
      .bind(fetched.validators.etag, fetched.validators.lastModified, feed.id)
      .run();
    return { newArticles, error: undefined as string | undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await db
      .prepare(`UPDATE feeds SET last_fetched_at = datetime('now'), last_status = ? WHERE id = ?`)
      .bind(`error: ${message}`, feed.id)
      .run();
    return { newArticles: 0, error: message };
  }
}

const REFRESH_CONCURRENCY = 5;

export async function refreshAllFeeds(db: D1Database) {
  const { results } = await db.prepare(`SELECT ${FEED_REFRESH_COLUMNS} FROM feeds`).all<FeedToRefresh>();
  const details: Array<{ feedId: number; newArticles: number; error?: string }> = [];

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < results.length) {
      const feed = results[nextIndex++];
      const r = await refreshFeed(db, feed);
      details.push({ feedId: feed.id, newArticles: r.newArticles, error: r.error });
    }
  }
  const workerCount = Math.min(REFRESH_CONCURRENCY, results.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  const totalNew = details.reduce((sum, d) => sum + d.newArticles, 0);
  return { totalNew, details };
}
