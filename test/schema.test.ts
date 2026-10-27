// Guards deploys: a database created fresh from schema.sql must match one that started from the
// pre-0005 schema and had every later migration applied in order. If they drift, one of the two
// paths would give the app a column or index the code doesn't expect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

function describeSchema(db: DatabaseSync) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const columns = Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (db.prepare(`PRAGMA table_info(${name})`).all() as Array<Record<string, unknown>>)
        .map((c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value} pk=${c.pk}`)
        .sort(),
    ]),
  );
  const indexes = (
    db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
      .all() as Array<{ name: string; tbl_name: string; sql: string }>
  ).map((index) => {
    const cols = (db.prepare(`PRAGMA index_xinfo(${index.name})`).all() as Array<Record<string, unknown>>)
      .filter((c) => c.key)
      .map((c) => `${c.name}${c.desc ? " DESC" : ""}`);
    const where = /\bWHERE\b(.*)$/is.exec(index.sql)?.[1].replace(/\s+/g, " ").trim() ?? "";
    return `${index.name} ON ${index.tbl_name}(${cols.join(", ")})${where ? ` WHERE ${where}` : ""}`;
  });
  return { tables: tables.map((t) => t.name), columns, indexes };
}

test("schema.sql matches the pre-0005 schema plus every migration since", () => {
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(read("schema.sql"));

  const migrated = new DatabaseSync(":memory:");
  migrated.exec(read("test/fixtures/schema-before-0005.sql"));
  const migrations = readdirSync(new URL("migrations/", root))
    .filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) >= 5)
    .sort();
  assert.ok(migrations.length >= 4, "expected migrations 0005 onwards");
  for (const file of migrations) migrated.exec(read(`migrations/${file}`));

  assert.deepEqual(describeSchema(migrated), describeSchema(fresh));
});

test("migrations backfill existing rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(read("test/fixtures/schema-before-0005.sql"));
  db.exec(`
    INSERT INTO feeds (id, url, title) VALUES (1, 'https://x.test/feed', 'X');
    INSERT INTO articles (id, feed_id, guid, title, url, published_at, fetched_at, progress, progress_updated_at)
      VALUES (1, 1, 'a', 'Dated', 'https://x.test/a', '2025-01-02T03:04:05.000Z', '2026-01-01 00:00:00', 0.5, '2026-01-05 10:00:00'),
             (2, 1, 'b', 'Undated', 'https://x.test/b', NULL, '2026-02-03 04:05:06', 0, NULL),
             (3, 1, 'c', 'Future', 'https://x.test/c', '2099-01-01T00:00:00.000Z', '2026-03-01 00:00:00', 0, NULL);
    INSERT INTO highlights (id, text) VALUES (7, 'first'), (9, 'second');
  `);
  for (const file of readdirSync(new URL("migrations/", root)).filter((f) => Number(f.slice(0, 4)) >= 5).sort()) {
    db.exec(read(`migrations/${file}`));
  }
  const sortAt = Object.fromEntries(
    (db.prepare("SELECT id, sort_at FROM articles").all() as Array<{ id: number; sort_at: string }>).map((r) => [r.id, r.sort_at]),
  );
  assert.deepEqual(sortAt, {
    1: "2025-01-02T03:04:05.000Z",
    2: "2026-02-03T04:05:06.000Z",
    3: "2026-03-01T00:00:00.000Z",
  });
  assert.deepEqual(
    db.prepare("SELECT id, position FROM highlights ORDER BY id").all().map((r) => ({ ...r })),
    [
      { id: 7, position: 7 },
      { id: 9, position: 9 },
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT day, article_id FROM reading_log").all().map((r) => ({ ...r })),
    [{ day: "2026-01-05", article_id: 1 }],
  );
  // Existing snippets become one script called "My List", keeping their order.
  assert.deepEqual(
    db.prepare("SELECT id, title FROM scripts").all().map((r) => ({ ...r })),
    [{ id: 1, title: "My List" }],
  );
  assert.deepEqual(
    db.prepare("SELECT id, script_id FROM highlights ORDER BY position").all().map((r) => ({ ...r })),
    [
      { id: 7, script_id: 1 },
      { id: 9, script_id: 1 },
    ],
  );
});
