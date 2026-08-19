export interface ScorableArticle {
  title: string;
  summary: string | null;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let idx = 0;
  while ((idx = h.indexOf(n, idx)) !== -1) {
    count++;
    idx += n.length;
  }
  return count;
}

// Title hits count more than summary hits toward the "badass" score.
export function scoreArticle(article: ScorableArticle, keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    score += countOccurrences(article.title, keyword) * 3;
    score += countOccurrences(article.summary ?? "", keyword);
  }
  return score;
}

// Escapes SQL LIKE wildcards so a topic keyword is matched literally, not as a pattern.
export function likePattern(keyword: string): string {
  return `%${keyword.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
}
