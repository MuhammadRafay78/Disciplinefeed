import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, placeholders } from "../src/sql.ts";

test("chunk splits into runs no longer than the limit", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.equal(chunk(Array.from({ length: 181 }, (_, i) => i)).length, 3);
});

test("placeholders lists one ? per value", () => {
  assert.equal(placeholders(3), "?, ?, ?");
});
