-- Several saved scripts instead of a single My List. Existing snippets become a script named "My List".
CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- New snippets go to the most recently selected script.
  selected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
ALTER TABLE highlights ADD COLUMN script_id INTEGER;
INSERT INTO scripts (title) SELECT 'My List' WHERE NOT EXISTS (SELECT 1 FROM scripts);
UPDATE highlights SET script_id = (SELECT MIN(id) FROM scripts) WHERE script_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_highlights_script ON highlights(script_id, position);
