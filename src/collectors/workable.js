import { fetchJson } from './http.js';
import { makePosting } from '../lib/posting.js';
import { htmlToText } from '../lib/text.js';
import { foldRemote } from '../lib/remote.js';
import { isoDate } from '../lib/dates.js';

export const BASE = 'https://apply.workable.com/api/v1/widget/accounts';

/** Pure: raw board response to postings. Tested against a recorded fixture. */
export function mapWorkable(data, slug, name = null) {
  const company = name || data?.name || slug;
  const out = [];
  for (const j of data?.jobs ?? []) {
    const location = [j.city, j.state, j.country].filter(Boolean).join(', ');
    // Workable splits the posting into three fields and the requirements are
    // the half that decides whether a role is viable.
    const description = [
      htmlToText(j.description),
      htmlToText(j.requirements),
      htmlToText(j.benefits),
    ].filter(Boolean).join('\n\n').trim();

    out.push(makePosting({
      source: `workable:${slug}`,
      company,
      title: j.title ?? '',
      location,
      url: j.shortlink || j.url || '',
      description,
      remote: foldRemote(j.telecommuting, location),
      employmentType: j.employment_type ?? null,
      postedAt: isoDate(j.published_on ?? j.created_at),
    }));
  }
  return out;
}

/**
 * Note the asymmetry with SmartRecruiters: Workable 404s an unknown slug, so
 * an empty list here is a real answer (the board exists, nobody is hiring)
 * rather than an unanswerable one.
 */
export async function fetchWorkable(slug, name = null, opts = {}) {
  // details=true returns full descriptions in the same call, so no N+1.
  const data = await fetchJson(`${BASE}/${slug}`, { params: { details: 'true' }, ...opts });
  return mapWorkable(data, slug, name);
}
