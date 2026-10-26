import { XMLParser } from "fast-xml-parser";

export interface ParsedArticle {
  guid: string;
  title: string;
  url: string;
  author?: string;
  publishedAt?: string;
  summary?: string;
  contentHtml?: string;
  // ISO timestamp the article is ordered by: its publish date, clamped to "now" so a feed with
  // bogus future dates can't pin itself to the top, or "now" when the feed gives no date.
  sortAt: string;
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

export function sortKeyFor(publishedAt: string | undefined, nowIso: string): string {
  return publishedAt && publishedAt < nowIso ? publishedAt : nowIso;
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

// A malicious feed could set <link> to a javascript:/data: URI; that value ends up as an
// <a href> in the reader UI, so only ever accept http(s) links out of feed XML.
function safeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function parseFeed(xml: string, now: Date = new Date()): ParsedFeed {
  const doc = parser.parse(xml);
  const nowIso = now.toISOString();

  if (doc.rss?.channel) {
    const channel = doc.rss.channel;
    const items = asArray<Record<string, unknown>>(channel.item);
    return {
      title: textOf(channel.title) ?? "Untitled feed",
      siteUrl: safeHttpUrl(linkOf(channel.link)),
      articles: items.map((item): ParsedArticle => {
        const url = safeHttpUrl(linkOf(item.link)) ?? "";
        const publishedAt = parseDate(textOf(item.pubDate));
        return {
          guid: textOf(item.guid) ?? url ?? textOf(item.title) ?? crypto.randomUUID(),
          title: textOf(item.title) ?? "Untitled",
          url,
          author: textOf(item["dc:creator"]) ?? textOf(item.author),
          publishedAt,
          summary: stripHtml(textOf(item.description)),
          contentHtml: textOf(item["content:encoded"]) ?? textOf(item.description),
          sortAt: sortKeyFor(publishedAt, nowIso),
        };
      }),
    };
  }

  if (doc.feed) {
    const feed = doc.feed;
    const entries = asArray<Record<string, unknown>>(feed.entry);
    return {
      title: textOf(feed.title) ?? "Untitled feed",
      siteUrl: safeHttpUrl(linkOf(feed.link)),
      articles: entries.map((entry): ParsedArticle => {
        const url = safeHttpUrl(linkOf(entry.link)) ?? "";
        const authorObj = entry.author as Record<string, unknown> | undefined;
        const publishedAt = parseDate(textOf(entry.published) ?? textOf(entry.updated));
        return {
          guid: textOf(entry.id) ?? url ?? crypto.randomUUID(),
          title: textOf(entry.title) ?? "Untitled",
          url,
          author: authorObj ? textOf(authorObj.name) : undefined,
          publishedAt,
          summary: stripHtml(textOf(entry.summary)),
          contentHtml: textOf(entry.content) ?? textOf(entry.summary),
          sortAt: sortKeyFor(publishedAt, nowIso),
        };
      }),
    };
  }

  throw new Error("Unrecognized feed format (not RSS 2.0 or Atom)");
}

// svg/math are dropped wholesale: their xlink:href and <animate>/<set> elements offer ways to
// smuggle in a javascript: URL that per-attribute checks can't reliably catch.
const DANGEROUS_TAGS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "link",
  "meta",
  "form",
  "base",
  "applet",
  "svg",
  "math",
];

// Attributes a browser may load or navigate to as a URL.
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "background", "data", "cite"]);
const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

function decodeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\uFFFD";
}

// HTMLRewriter hands us attribute values still entity-encoded, while the browser decodes them and
// drops tabs/newlines before resolving the URL, so "jav&#x61;script:" or "java\tscript:" would slip
// past a naive prefix check and run as javascript:. Normalize the way the browser does, then allow
// only relative URLs or an explicit list of schemes.
export function isSafeContentUrl(raw: string, allowDataImage = false): boolean {
  const normalized = raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => decodeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => decodeCodePoint(Number(dec)))
    .replace(/&colon;/gi, ":")
    .replace(/&(tab|newline);/gi, "")
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, "")
    .toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized)?.[1];
  if (!scheme) return true;
  if (SAFE_URL_SCHEMES.has(scheme)) return true;
  return allowDataImage && /^data:image\/(png|jpe?g|gif|webp|avif);/.test(normalized);
}

export async function sanitizeHtml(html: string): Promise<string> {
  let rewriter = new HTMLRewriter();
  for (const tag of DANGEROUS_TAGS) {
    rewriter = rewriter.on(tag, {
      element(el) {
        el.remove();
      },
    });
  }
  rewriter = rewriter
    .on("*", {
      element(el) {
        for (const [name, value] of el.attributes) {
          const lower = name.toLowerCase();
          if (lower.startsWith("on")) {
            el.removeAttribute(name);
          } else if (URL_ATTRS.has(lower) && !isSafeContentUrl(value, lower === "src" && el.tagName === "img")) {
            el.removeAttribute(name);
          }
        }
      },
    })
    // Links inside an article must never navigate the reader itself away from the app.
    .on("a", {
      element(el) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      },
    });

  const res = rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  return res.text();
}
