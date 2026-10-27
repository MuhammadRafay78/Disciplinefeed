import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanScriptTitle, MAX_SCRIPT_TITLE_LENGTH } from "../src/scripts.ts";

test("cleanScriptTitle trims, collapses whitespace and caps length", () => {
  assert.equal(cleanScriptTitle("  Morning   routine\n reel "), "Morning routine reel");
  assert.equal(cleanScriptTitle("x".repeat(200))?.length, MAX_SCRIPT_TITLE_LENGTH);
  assert.equal(cleanScriptTitle("   "), null);
  assert.equal(cleanScriptTitle(42), null);
});
