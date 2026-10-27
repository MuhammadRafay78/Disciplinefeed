// OPML is the interchange format RSS readers use for subscription lists.

export interface OpmlFeed {
  title: string;
  url: string;
  site_url: string | null;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]!);
}

export function buildOpml(feeds: OpmlFeed[], now: Date = new Date()): string {
  const outlines = feeds.map((feed) => {
    const title = escapeXml(feed.title);
    const htmlUrl = feed.site_url ? ` htmlUrl="${escapeXml(feed.site_url)}"` : "";
    return `    <outline type="rss" text="${title}" title="${title}" xmlUrl="${escapeXml(feed.url)}"${htmlUrl}/>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    "    <title>DisciplineFeed subscriptions</title>",
    `    <dateCreated>${now.toUTCString()}</dateCreated>`,
    "  </head>",
    "  <body>",
    ...outlines,
    "  </body>",
    "</opml>",
    "",
  ].join("\n");
}
