import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeEntities,
  htmlToText,
  iframeReplacement,
  isSafeContentUrl,
  parseFeed,
  sortKeyFor,
  youtubeVideoId,
} from "../src/parse.ts";

test("isSafeContentUrl allows http(s), mailto and relative URLs", () => {
  for (const url of ["https://example.com/a", "http://x.y", "mailto:a@b.c", "/relative", "page.html", "#top", "?q=1"]) {
    assert.equal(isSafeContentUrl(url), true, url);
  }
});

test("isSafeContentUrl rejects script URLs however they are disguised", () => {
  const attacks = [
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "jav&#x61;script:alert(1)",
    "jav&#97;script:alert(1)",
    "jav&#x61script:alert(1)",
    "java\tscript:alert(1)",
    "java&Tab;script:alert(1)",
    "javascript&colon;alert(1)",
    "\u0001javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
  ];
  for (const url of attacks) assert.equal(isSafeContentUrl(url), false, url);
});

test("isSafeContentUrl only allows raster data: images, and only when asked", () => {
  assert.equal(isSafeContentUrl("data:image/png;base64,AAAA", true), true);
  assert.equal(isSafeContentUrl("data:image/png;base64,AAAA"), false);
  assert.equal(isSafeContentUrl("data:image/svg+xml;base64,AAAA", true), false);
});

test("sortKeyFor clamps future and missing dates to now", () => {
  const now = "2026-05-01T00:00:00.000Z";
  assert.equal(sortKeyFor("2026-04-01T00:00:00.000Z", now), "2026-04-01T00:00:00.000Z");
  assert.equal(sortKeyFor("2099-01-01T00:00:00.000Z", now), now);
  assert.equal(sortKeyFor(undefined, now), now);
});

test("parseFeed reads RSS items and drops non-http links", () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel><title>Feed</title><link>https://site.test/</link>
      <item><title>One</title><link>https://site.test/1</link><guid>g1</guid>
        <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate><description>&lt;p&gt;Hello &lt;b&gt;there&lt;/b&gt;&lt;/p&gt;</description></item>
      <item><title>Evil</title><link>javascript:alert(1)</link><guid>g2</guid></item>
    </channel></rss>`;
  const now = new Date("2026-05-01T00:00:00.000Z");
  const feed = parseFeed(xml, now);
  assert.equal(feed.title, "Feed");
  assert.equal(feed.siteUrl, "https://site.test/");
  assert.equal(feed.articles.length, 2);
  const [one, evil] = feed.articles;
  assert.equal(one.url, "https://site.test/1");
  assert.equal(one.publishedAt, "2024-01-01T10:00:00.000Z");
  assert.equal(one.sortAt, "2024-01-01T10:00:00.000Z");
  assert.equal(one.summary, "Hello there");
  assert.equal(evil.url, "");
  assert.equal(evil.sortAt, now.toISOString());
});

test("parseFeed reads Atom entries", () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title>
      <link href="https://atom.test/" rel="alternate"/>
      <entry><id>e1</id><title>Entry</title><link href="https://atom.test/e1"/>
        <updated>2025-02-03T04:05:06Z</updated><author><name>Ann</name></author><content>Body</content></entry>
    </feed>`;
  const feed = parseFeed(xml);
  assert.equal(feed.title, "Atom");
  assert.equal(feed.articles[0].url, "https://atom.test/e1");
  assert.equal(feed.articles[0].author, "Ann");
  assert.equal(feed.articles[0].publishedAt, "2025-02-03T04:05:06.000Z");
});

test("parseFeed rejects documents that aren't RSS or Atom", () => {
  assert.throws(() => parseFeed("<html><body>nope</body></html>"), /Unrecognized feed format/);
});

test("decodeEntities handles numeric and common named entities in one pass", () => {
  assert.equal(decodeEntities("Don&#8217;t &amp; won&#x2019;t &mdash; &hellip;"), "Don’t & won’t — …");
  assert.equal(decodeEntities("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
  assert.equal(decodeEntities("&unknownentity; &#0; & alone"), "&unknownentity; &#0; & alone");
});

test("htmlToText strips markup, decodes entities and collapses whitespace", () => {
  assert.equal(
    htmlToText("<p>Fish &amp; <b>chips</b></p>\n<style>p{}</style><p>Sit&nbsp;with   it.</p>"),
    "Fish & chips Sit with it.",
  );
});

test("parseFeed decodes HTML entities in titles and summaries", () => {
  const xml = `<rss version="2.0"><channel><title>T</title>
    <item><title>Don&#8217;t quit</title><link>https://x.test/1</link><guid>1</guid>
      <description><![CDATA[<p>Fish &amp; chips &#8212; tasty</p>]]></description></item>
  </channel></rss>`;
  const [article] = parseFeed(xml).articles;
  assert.equal(article.title, "Don’t quit");
  assert.equal(article.summary, "Fish & chips — tasty");
});

test("youtubeVideoId reads embed and short links", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://www.youtube-nocookie.com/embed/abc_DEF-123"), "abc_DEF-123");
  assert.equal(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://vimeo.com/123"), null);
});

test("iframeReplacement links to what the iframe showed, and only to safe https URLs", () => {
  assert.equal(
    iframeReplacement("https://www.youtube.com/embed/dQw4w9WgXcQ"),
    '<p class="embed-link"><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" target="_blank" rel="noopener noreferrer">▶ Watch the video on YouTube</a></p>',
  );
  assert.match(
    iframeReplacement("https://open.spotify.com/embed/episode/x?a=1&amp;b=2") ?? "",
    /href="https:\/\/open\.spotify\.com\/embed\/episode\/x\?a=1&amp;b=2".*from open\.spotify\.com/,
  );
  assert.equal(iframeReplacement("javascript:alert(1)"), null);
  assert.equal(iframeReplacement("http://insecure.test/embed"), null);
  assert.equal(iframeReplacement('https://x.test/"><script>'), '<p class="embed-link"><a href="https://x.test/&quot;&gt;&lt;script&gt;" target="_blank" rel="noopener noreferrer">Open embedded content from x.test ↗</a></p>');
});
