-- Order articles by publish date instead of insertion order. Backfill from published_at, clamped to
-- (and falling back to) fetched_at, normalized to the same ISO-8601 format the app writes.
ALTER TABLE articles ADD COLUMN sort_at TEXT;
UPDATE articles SET sort_at = MIN(
  COALESCE(published_at, strftime('%Y-%m-%dT%H:%M:%fZ', fetched_at)),
  strftime('%Y-%m-%dT%H:%M:%fZ', fetched_at)
);
CREATE INDEX IF NOT EXISTS idx_articles_sort ON articles(sort_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_articles_feed_sort ON articles(feed_id, sort_at DESC, id DESC);

-- HTTP cache validators so scheduled refreshes can skip unchanged feeds (304 Not Modified).
ALTER TABLE feeds ADD COLUMN etag TEXT;
ALTER TABLE feeds ADD COLUMN last_modified TEXT;
