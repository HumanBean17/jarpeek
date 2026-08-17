/**
 * Fuzzy matching for class and symbol search.
 *
 * fuzzyScore answers "does this query appear inside the target as a
 * case-insensitive subsequence, and how well". The scale is deliberately
 * coarse so exact and prefix hits dominate: +100 exact, +50 prefix, +30 a
 * camelCase hump or `_`/`.`/`-` boundary (or target start), +2 per
 * consecutive matched character, +1 otherwise, and −1 per 10 characters of
 * target length. topMatches turns scores into a ranked, stable list.
 */

export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q === t) return 100;
  if (q.length === 0) return null;
  if (!t.startsWith(q)) {
    // Subsequence check: a greedy left-to-right scan finds a match iff one
    // exists, and the greedy positions are also where the score is computed.
    let pos = 0;
    for (const ch of t) {
      if (pos < q.length && ch === q[pos]) pos++;
    }
    if (pos < q.length) return null;
  }

  let score = 0;
  if (t.startsWith(q)) score += 50;
  let qi = 0;
  let prevHit = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    if (ti === 0 || /[a-z][A-Z]/.test(target[ti - 1]! + target[ti]!) || "_-.".includes(target[ti - 1]!)) {
      score += 30;
    } else {
      score += prevHit === ti - 1 ? 2 : 1;
    }
    prevHit = ti;
    qi++;
  }
  // Consecutive-run bonus is folded into the per-char award above; length
  // penalty favors short targets among otherwise equal matches.
  score -= Math.floor(t.length / 10);
  return score;
}

export interface ScoredMatch<T> {
  item: T;
  score: number;
}

/**
 * Rank items whose label fuzzy-matches the query: score-descending, stable
 * (ties keep input order), non-matches dropped, at most `limit` kept.
 */
export function topMatches<T>(
  items: T[],
  label: (t: T) => string,
  query: string,
  limit: number,
): Array<{ item: T; score: number }> {
  const scored: Array<{ item: T; score: number; index: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const s = fuzzyScore(query, label(items[i]!));
    if (s !== null) scored.push({ item: items[i]!, score: s, index: i });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map(({ item, score }) => ({ item, score }));
}
