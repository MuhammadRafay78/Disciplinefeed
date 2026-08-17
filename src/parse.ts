import { XMLParser } from "fast-xml-parser";

export interface ParsedArticle {
  guid: string;
  title: string;
  url: string;
  author?: string;
  publishedAt?: string;
  summary?: string;
  contentHtml?: string;
}

export interface ParsedFeed {
  title: string;
  siteUrl?: string;
  articles: ParsedArticle[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function textOf(val: unknown): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") return val.trim() || undefined;
  if (typeof val === "object" && "#text" in (val as Record<string, unknown>)) {
    return String((val as Record<string, unknown>)["#text"]).trim() || undefined;
  }
  return String(val).trim() || undefined;
}

function linkOf(val: unknown): string | undefined {
  // RSS: <link>url</link> -> plain string
  // Atom: <link href="url" rel="alternate"/> -> object, or array of link objects
  if (val == null) return undefined;
  if (typeof val === "string") return val.trim() || undefined;
  if (Array.isArray(val)) {
    const alt =
      (val as Array<Record<string, unknown>>).find(
        (v) => !v["@_rel"] || v["@_rel"] === "alternate",
      ) ?? val[0];
    return linkOf(alt);
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    return (obj["@_href"] as string | undefined) ?? textOf(obj);
  }
  return undefined;
}

function parseDate(s?: string): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function stripHtml(s?: string): string | undefined {
  if (!s) return undefined;
  const text = s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function asArray<T>(val: T | T[] | undefined): T[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

export function parseFeed(xml: string): ParsedFeed {
  const doc = parser.parse(xml);

  if (doc.rss?.channel) {
    const channel = doc.rss.channel;
    const items = asArray<Record<string, unknown>>(channel.item);
    return {
      title: textOf(channel.title) ?? "Untitled feed",
      siteUrl: linkOf(channel.link),
      articles: items.map((item): ParsedArticle => {
        const url = linkOf(item.link) ?? "";
        return {
          guid: textOf(item.guid) ?? url ?? textOf(item.title) ?? crypto.randomUUID(),
          title: textOf(item.title) ?? "Untitled",
          url,
          author: textOf(item["dc:creator"]) ?? textOf(item.author),
          publishedAt: parseDate(textOf(item.pubDate)),
          summary: stripHtml(textOf(item.description)),
          contentHtml: textOf(item["content:encoded"]) ?? textOf(item.description),
        };
      }),
    };
  }

  if (doc.feed) {
    const feed = doc.feed;
    const entries = asArray<Record<string, unknown>>(feed.entry);
    return {
      title: textOf(feed.title) ?? "Untitled feed",
      siteUrl: linkOf(feed.link),
      articles: entries.map((entry): ParsedArticle => {
        const url = linkOf(entry.link) ?? "";
        const authorObj = entry.author as Record<string, unknown> | undefined;
        return {
          guid: textOf(entry.id) ?? url ?? crypto.randomUUID(),
          title: textOf(entry.title) ?? "Untitled",
          url,
          author: authorObj ? textOf(authorObj.name) : undefined,
          publishedAt: parseDate(textOf(entry.published) ?? textOf(entry.updated)),
          summary: stripHtml(textOf(entry.summary)),
          contentHtml: textOf(entry.content) ?? textOf(entry.summary),
        };
      }),
    };
  }

  throw new Error("Unrecognized feed format (not RSS 2.0 or Atom)");
}

const DANGEROUS_TAGS = ["script", "style", "iframe", "object", "embed", "link", "meta", "form", "base", "applet"];

export async function sanitizeHtml(html: string): Promise<string> {
  let rewriter = new HTMLRewriter();
  for (const tag of DANGEROUS_TAGS) {
    rewriter = rewriter.on(tag, {
      element(el) {
        el.remove();
      },
    });
  }
  rewriter = rewriter.on("*", {
    element(el) {
      for (const [name, value] of el.attributes) {
        const lower = name.toLowerCase();
        if (lower.startsWith("on")) {
          el.removeAttribute(name);
        } else if ((lower === "href" || lower === "src") && /^\s*javascript:/i.test(value)) {
          el.removeAttribute(name);
        }
      }
    },
  });

  const res = rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  return res.text();
}
