import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeExcerpt } from "../src/search.ts";

test("shapeExcerpt trims partial words and marks cut sides", () => {
  const text = "alpha bravo charlie delta echo foxtrot golf";
  // Window "avo charlie delta ec" taken from the middle.
  const start = text.indexOf("avo") + 1;
  assert.equal(shapeExcerpt("avo charlie delta ec", start, text.length), "…charlie delta…");
});

test("shapeExcerpt leaves uncut edges alone", () => {
  assert.equal(shapeExcerpt("alpha bravo", 1, 11), "alpha bravo");
  assert.equal(shapeExcerpt("alpha bravo char", 1, 30), "alpha bravo…");
  assert.equal(shapeExcerpt("ha bravo", 4, 11), "…bravo");
});
