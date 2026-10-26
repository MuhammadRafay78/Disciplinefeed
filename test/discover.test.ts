import { test } from "node:test";
import assert from "node:assert/strict";
import { likePattern, scoreArticle } from "../src/discover.ts";

test("scoreArticle weights title hits above summary hits", () => {
  const keywords = ["discipline"];
  assert.equal(scoreArticle({ title: "Discipline wins", summary: null }, keywords), 3);
  assert.equal(scoreArticle({ title: "Habits", summary: "discipline, discipline" }, keywords), 2);
  assert.equal(scoreArticle({ title: "Habits", summary: "focus" }, keywords), 0);
});

test("likePattern escapes LIKE wildcards", () => {
  assert.equal(likePattern("100%_done\\"), "%100\\%\\_done\\\\%");
});
