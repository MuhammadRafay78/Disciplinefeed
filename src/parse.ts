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

// The XML parser resolves XML's own entities, but feeds routinely carry HTML entities on top
// (WordPress writes every apostrophe as &#8217;). This covers numeric references and the named
// ones that show up in practice; anything else is left as written.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  divide: "÷",
  frac12: "½",
  euro: "€",
  pound: "£",
  cent: "¢",
  sect: "§",
  para: "¶",
  prime: "′",
  Prime: "″",
  shy: "",
  zwj: "\u200d",
  zwnj: "\u200c",
};

// Single pass, so "&amp;lt;" becomes the text "&lt;" rather than being decoded twice into "<".
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[name] ?? match;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function plainText(s?: string): string | undefined {
  return s ? decodeEntities(s).trim() || undefined : undefined;
}

function stripHtml(s?: string): string | undefined {
  if (!s) return undefined;
  const text = htmlToText(s);
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
      title: plainText(textOf(channel.title)) ?? "Untitled feed",
      siteUrl: safeHttpUrl(linkOf(channel.link)),
      articles: items.map((item): ParsedArticle => {
        const url = safeHttpUrl(linkOf(item.link)) ?? "";
        const publishedAt = parseDate(textOf(item.pubDate));
        return {
          guid: textOf(item.guid) ?? url ?? textOf(item.title) ?? crypto.randomUUID(),
          title: plainText(textOf(item.title)) ?? "Untitled",
          url,
          author: plainText(textOf(item["dc:creator"]) ?? textOf(item.author)),
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
      title: plainText(textOf(feed.title)) ?? "Untitled feed",
      siteUrl: safeHttpUrl(linkOf(feed.link)),
      articles: entries.map((entry): ParsedArticle => {
        const url = safeHttpUrl(linkOf(entry.link)) ?? "";
        const authorObj = entry.author as Record<string, unknown> | undefined;
        const publishedAt = parseDate(textOf(entry.published) ?? textOf(entry.updated));
        return {
          guid: textOf(entry.id) ?? url ?? crypto.randomUUID(),
          title: plainText(textOf(entry.title)) ?? "Untitled",
          url,
          author: authorObj ? plainText(textOf(authorObj.name)) : undefined,
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

// Inert page chrome in feed HTML (e.g. Substack's image expand/restack buttons) that does nothing
// outside its own site.
const CHROME_TAGS = ["button", "input", "select", "textarea"];

// Substack "Subscribe now" / "Share" buttons; other author buttons (e.g. "Preorder") are kept.
const SUBSTACK_PROMO_BUTTON = /\/subscribe\b|[?&]action=share\b|utm_content=share\b/;

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function embedLink(url: string, label: string): string {
  return `<p class="embed-link"><a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeAttr(label)}</a></p>`;
}

export function youtubeVideoId(src: string): string | null {
  return /(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{6,20})/.exec(src)?.[1] ?? null;
}

// Iframes can't run here, so rather than silently dropping one, leave a link to what it showed.
export function iframeReplacement(rawSrc: string): string | null {
  const src = decodeEntities(rawSrc).trim();
  const videoId = youtubeVideoId(src);
  if (videoId) return embedLink(`https://www.youtube.com/watch?v=${videoId}`, "▶ Watch the video on YouTube");
  if (!/^https:\/\//i.test(src) || !isSafeContentUrl(src)) return null;
  try {
    return embedLink(src, `Open embedded content from ${new URL(src).hostname} ↗`);
  } catch {
    return null;
  }
}

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
  for (const tag of [...DANGEROUS_TAGS, ...CHROME_TAGS]) {
    rewriter = rewriter.on(tag, {
      element(el) {
        el.remove();
      },
    });
  }
  rewriter = rewriter
    .on("iframe", {
      element(el) {
        const replacement = iframeReplacement(el.getAttribute("src") ?? "");
        if (replacement) el.replace(replacement, { html: true });
        else el.remove();
      },
    })
    // Substack wraps YouTube embeds and keeps the video id in data-attrs; stored articles only
    // have the (now empty) wrapper left, so this rebuilds the link for them too.
    .on("div.youtube-wrap", {
      element(el) {
        const videoId = /"videoId":"([\w-]{6,20})"/.exec(decodeEntities(el.getAttribute("data-attrs") ?? ""))?.[1];
        if (videoId) {
          el.setInnerContent(embedLink(`https://www.youtube.com/watch?v=${videoId}`, "▶ Watch the video on YouTube"), {
            html: true,
          });
        }
      },
    })
    .on('div[class*="subscription-widget"]', {
      element(el) {
        el.remove();
      },
    })
    .on("p.button-wrapper", {
      element(el) {
        if (SUBSTACK_PROMO_BUTTON.test(decodeEntities(el.getAttribute("data-attrs") ?? ""))) el.remove();
      },
    });
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
    // Links inside an article must never navigate the reader itself away from the app; in-page
    // jumps (footnotes) are the exception and stay in the reader.
    .on("a", {
      element(el) {
        if ((el.getAttribute("href") ?? "").startsWith("#")) {
          el.removeAttribute("target");
          return;
        }
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      },
    });

  const res = rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  return res.text();
}
