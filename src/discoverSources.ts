// Finds new Substack publications for a topic. Substack has no documented free-text
// publication search API; the endpoints below were confirmed by hand against the live
// site (its own search page fetches results client-side, so there's nothing stable to
// call directly for arbitrary keywords). Instead we match the topic against Substack's
// fixed category taxonomy, browse the matching categories' "top publications" lists,
// and rank those by keyword hits — a coarser net than true search, but grounded in a
// real, stable endpoint.

export interface SuggestedSource {
  title: string;
  subdomain: string;
  siteUrl: string;
  feedUrl: string;
  description?: string;
}

interface SubstackCategory {
  id: number | string;
  name: string;
  slug: string;
  active?: boolean;
  subcategories?: SubstackCategory[];
}

interface SubstackPublication {
  name?: string;
  subdomain?: string;
  custom_domain?: string;
  hero_text?: string;
}

interface SubstackCategoryPage {
  publications: SubstackPublication[];
  more: boolean;
}

const SUBSTACK_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

// DisciplineFeed's own domain (self-improvement, focus, habits) doesn't map to any single
// Substack category, so when a topic doesn't literally match a category name we fall back
// to browsing the categories most likely to contain that kind of writing.
const FALLBACK_CATEGORY_SLUGS = ["health", "business", "philosophy", "education"];
const MAX_CATEGORIES = 4;
const PAGES_PER_CATEGORY = 4;
const MAX_RESULTS = 20;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: SUBSTACK_HEADERS });
  if (!res.ok) throw new Error(`Substack request failed (HTTP ${res.status})`);
  return res.json<T>();
}

function matchingCategoryIds(categories: SubstackCategory[], topic: string): Array<number | string> {
  const needle = topic.toLowerCase();
  const ids = new Set<number | string>();
  for (const cat of categories) {
    if (cat.active === false) continue;
    const nameHit = cat.name.toLowerCase().includes(needle);
    const subHit = (cat.subcategories ?? []).some((sub) => sub.name.toLowerCase().includes(needle));
    if (nameHit || subHit) ids.add(cat.id);
  }
  return [...ids];
}

export async function findSubstackPublicationsForTopic(topic: string): Promise<SuggestedSource[]> {
  const categories = await fetchJson<SubstackCategory[]>("https://substack.com/api/v1/categories");

  let categoryIds = matchingCategoryIds(categories, topic);
  if (categoryIds.length === 0) {
    categoryIds = categories.filter((c) => FALLBACK_CATEGORY_SLUGS.includes(c.slug)).map((c) => c.id);
  }
  categoryIds = categoryIds.slice(0, MAX_CATEGORIES);

  const publications: SubstackPublication[] = [];
  for (const id of categoryIds) {
    for (let page = 0; page < PAGES_PER_CATEGORY; page++) {
      const data = await fetchJson<SubstackCategoryPage>(
        `https://substack.com/api/v1/category/public/${id}/all?page=${page}`,
      );
      publications.push(...data.publications);
      if (!data.more) break;
    }
  }

  const needle = topic.toLowerCase();
  const seenSubdomains = new Set<string>();
  const ranked: Array<SuggestedSource & { score: number }> = [];
  for (const pub of publications) {
    if (!pub.subdomain || seenSubdomains.has(pub.subdomain)) continue;
    seenSubdomains.add(pub.subdomain);

    const title = pub.name ?? pub.subdomain;
    const description = pub.hero_text || undefined;
    const score =
      (title.toLowerCase().includes(needle) ? 3 : 0) + (description?.toLowerCase().includes(needle) ? 1 : 0);
    if (score === 0) continue;

    const siteUrl = pub.custom_domain ? `https://${pub.custom_domain}` : `https://${pub.subdomain}.substack.com`;
    ranked.push({ title, subdomain: pub.subdomain, siteUrl, feedUrl: `${siteUrl}/feed`, description, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, MAX_RESULTS).map(({ score: _score, ...source }) => source);
}
