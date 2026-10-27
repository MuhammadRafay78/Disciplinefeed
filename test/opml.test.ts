import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpml } from "../src/opml.ts";

test("buildOpml lists every feed and escapes attribute values", () => {
  const xml = buildOpml(
    [
      { title: 'Grit & "Grind" <Weekly>', url: "https://a.test/feed?x=1&y=2", site_url: "https://a.test/" },
      { title: "No site", url: "https://b.test/rss", site_url: null },
    ],
    new Date("2026-01-02T03:04:05Z"),
  );
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<opml version="2.0">/);
  assert.match(xml, /<dateCreated>Fri, 02 Jan 2026 03:04:05 GMT<\/dateCreated>/);
  assert.ok(xml.includes('text="Grit &amp; &quot;Grind&quot; &lt;Weekly&gt;"'));
  assert.ok(xml.includes('xmlUrl="https://a.test/feed?x=1&amp;y=2" htmlUrl="https://a.test/"'));
  assert.ok(xml.includes('<outline type="rss" text="No site" title="No site" xmlUrl="https://b.test/rss"/>'));
});
