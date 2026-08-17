import { parseFeed, sanitizeHtml, type ParsedArticle } from "./parse";

const FETCH_HEADERS = {
  "User-Agent": "DisciplineFeedBot/1.0 (+personal RSS reader)",
  Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
};

async function fetchFeedXml(url: string): Promise<string> {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching feed`);
  return res.text();
}

async function upsertArticles(db: D1Database, feedId: number, articles: ParsedArticle[]): Promise<number> {
  let newCount = 0;
  for (const article of articles) {
    if (!article.url) continue;
    const contentHtml = article.contentHtml ? await sanitizeHtml(article.contentHtml) : null;
    const result = await db
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
      )
      .run();
    if (result.meta.changes > 0) newCount++;
  }
  return newCount;
}

export async function addFeed(db: D1Database, feedUrl: string) {
  const xml = await fetchFeedXml(feedUrl);
  const parsed = parseFeed(xml);

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
    const xml = await fetchFeedXml(feed.url);
    const parsed = parseFeed(xml);
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

export async function refreshAllFeeds(db: D1Database) {
  const { results } = await db.prepare("SELECT id, url FROM feeds").all<{ id: number; url: string }>();
  let totalNew = 0;
  const details: Array<{ feedId: number; newArticles: number; error?: string }> = [];
  for (const feed of results) {
    const r = await refreshFeed(db, feed);
    totalNew += r.newArticles;
    details.push({ feedId: feed.id, newArticles: r.newArticles, error: r.error });
  }
  return { totalNew, details };
}
