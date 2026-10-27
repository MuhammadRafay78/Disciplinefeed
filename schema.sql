CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  site_url TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_fetched_at TEXT,
  last_status TEXT,
  etag TEXT,
  last_modified TEXT
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  summary TEXT,
  content_html TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_saved INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  progress_updated_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Publish date clamped to fetch time (see sortKeyFor); what article lists are ordered by.
  sort_at TEXT,
  -- Plain text of content_html, for search ('' when there is no body).
  content_text TEXT,
  UNIQUE(feed_id, guid)
);

CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles(feed_id);
CREATE INDEX IF NOT EXISTS idx_articles_sort ON articles(sort_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_articles_feed_sort ON articles(feed_id, sort_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_articles_needs_text ON articles(id) WHERE content_text IS NULL;

-- Snippets the user selects from articles, plus freeform notes, for drafting scripts.
-- No FK to articles: notes should survive even if the source feed/article is later removed.
CREATE TABLE IF NOT EXISTS highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  article_id INTEGER,
  article_title TEXT,
  article_url TEXT,
  feed_title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Manual order within its script (ascending); new snippets go to the end.
  position INTEGER,
  -- The saved script this snippet belongs to (see scripts).
  script_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_highlights_script ON highlights(script_id, position);

-- Saved scripts, each an ordered list of highlights. New snippets go to the most recently selected one.
CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  selected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Keywords the user wants "badass" articles surfaced for, across all subscriptions.
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per article per (local) day it was opened; drives the reading streak.
CREATE TABLE IF NOT EXISTS reading_log (
  day TEXT NOT NULL,
  article_id INTEGER NOT NULL,
  PRIMARY KEY (day, article_id)
);
