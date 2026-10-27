-- Plain-text copy of each article body, for full-text search. Rows stored before this migration
-- are filled in (and their titles/summaries entity-decoded) a batch at a time by the scheduled job;
-- the partial index lets that job find them without scanning every article.
ALTER TABLE articles ADD COLUMN content_text TEXT;
CREATE INDEX IF NOT EXISTS idx_articles_needs_text ON articles(id) WHERE content_text IS NULL;
