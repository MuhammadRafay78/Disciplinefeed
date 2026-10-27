-- One row per article per (local) day it was opened; drives the reading streak. No foreign key, so
-- unsubscribing from a feed doesn't erase reading history.
CREATE TABLE IF NOT EXISTS reading_log (
  day TEXT NOT NULL,
  article_id INTEGER NOT NULL,
  PRIMARY KEY (day, article_id)
);
-- Seed from reading progress so an existing habit doesn't start back at zero.
INSERT OR IGNORE INTO reading_log (day, article_id)
  SELECT date(progress_updated_at), id FROM articles WHERE progress_updated_at IS NOT NULL;
