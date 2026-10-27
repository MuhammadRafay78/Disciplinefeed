-- Lets My List be reordered by hand. Existing snippets keep their creation order.
ALTER TABLE highlights ADD COLUMN position INTEGER;
UPDATE highlights SET position = id;
