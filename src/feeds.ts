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

async function fetchFeedXml(url: string): Promise<{ body: string; finalUrl: string }> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (res.ok) return { body: await res.text(), finalUrl: res.url || url };

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

async function fetchAndParseFeed(url: string): Promise<{ feedUrl: string; parsed: ReturnType<typeof parseFeed> }> {
  const { body, finalUrl } = await fetchFeedXml(url);
  try {
    return { feedUrl: finalUrl, parsed: parseFeed(body) };
  } catch (err) {
    const discovered = await discoverFeedUrl(body, finalUrl);
    if (!discovered) throw err;
    const { body: discoveredBody, finalUrl: discoveredFinalUrl } = await fetchFeedXml(discovered);
    return { feedUrl: discoveredFinalUrl, parsed: parseFeed(discoveredBody) };
  }
}

async function upsertArticles(db: D1Database, feedId: number, articles: ParsedArticle[]): Promise<number> {
  const withUrl = articles.filter((a) => a.url);
  if (withUrl.length === 0) return 0;

  const statements = await Promise.all(
    withUrl.map(async (article) => {
      const contentHtml = article.contentHtml ? await sanitizeHtml(article.contentHtml) : null;
      return db
        .prepare(
          `INSERT INTO articles (feed_id, guid, title, url, author, published_at, summary, content_html)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        );
    }),
  );

  const results = await db.batch(statements);
  return results.reduce((count, r) => count + (r.meta.changes > 0 ? 1 : 0), 0);
}

export async function addFeed(db: D1Database, inputUrl: string) {
  const { feedUrl, parsed } = await fetchAndParseFeed(inputUrl);

  const insertFeed = await db
    .prepare(
      `INSERT INTO feeds (url, title, site_url, last_fetched_at, last_status)
       VALUES (?, ?, ?, datetime('now'), 'ok')`,
    )
    .bind(feedUrl, parsed.title, parsed.siteUrl ?? null)
    .run();
  const feedId = Number(insertFeed.meta.last_row_id);

  const newArticles = await upsertArticles(db, feedId, parsed.articles);
  return { feedId, title: parsed.title, newArticles };
}

export async function refreshFeed(db: D1Database, feed: { id: number; url: string }) {
  try {
    const { body } = await fetchFeedXml(feed.url);
    const parsed = parseFeed(body);
    const newArticles = await upsertArticles(db, feed.id, parsed.articles);
    await db
      .prepare(`UPDATE feeds SET last_fetched_at = datetime('now'), last_status = 'ok' WHERE id = ?`)
      .bind(feed.id)
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
  const { results } = await db.prepare("SELECT id, url FROM feeds").all<{ id: number; url: string }>();
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
