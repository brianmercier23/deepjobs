// Six boards, six opinions about what a date looks like.

const FALLBACKS = [
  // YYYY-MM-DD and YYYY/MM/DD
  { re: /^(\d{4})[-/](\d{2})[-/](\d{2})$/, order: [1, 2, 3] },
  // DD-MM-YYYY
  { re: /^(\d{2})-(\d{2})-(\d{4})$/, order: [3, 2, 1] },
];

/**
 * Parse whatever a board sent into a plain YYYY-MM-DD string, or null.
 *
 * Everything is read as UTC on purpose. A local-time read makes the stored
 * date depend on which machine ran the crawl, which is the kind of difference
 * that shows up much later as two rows that should have been one.
 *
 * @returns {string|null}
 */
export function isoDate(value) {
  if (value === null || value === undefined || value === '') return null;

  // Lever reports epoch milliseconds.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  const s = String(value).trim();
  if (!s) return null;

  // Full ISO timestamps, with or without a zone.
  const parsed = new Date(s.length <= 10 ? `${s}T00:00:00Z` : s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  const head = s.slice(0, 10);
  for (const { re, order } of FALLBACKS) {
    const m = re.exec(head);
    if (m) return `${m[order[0]]}-${m[order[1]]}-${m[order[2]]}`;
  }
  return null;
}
