import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCursor, encodeCursor } from "../src/pagination.ts";

test("cursor round-trips", () => {
  const raw = encodeCursor("2026-01-01T10:00:00.000Z", 42);
  assert.deepEqual(decodeCursor(raw), { sortAt: "2026-01-01T10:00:00.000Z", id: 42 });
});

test("malformed cursors are rejected", () => {
  for (const raw of ["", "bogus", "|5", "2026-01-01|abc", "2026-01-01|-3", "2026-01-01|1.5"]) {
    assert.equal(decodeCursor(raw), null, raw);
  }
});
