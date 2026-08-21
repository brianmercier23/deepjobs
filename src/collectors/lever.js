import { fetchJson } from './http.js';
import { makePosting } from '../lib/posting.js';
import { htmlToText } from '../lib/text.js';
import { foldRemote } from '../lib/remote.js';
import { isoDate } from '../lib/dates.js';

export const BASE = 'https://api.lever.co/v0/postings';

/** Pure: raw board response to postings. Tested against a recorded fixture. */
export function mapLever(data, slug, name = null) {
  const out = [];
  for (const j of data ?? []) {
    const cats = j.categories ?? {};
    // A Lever posting is not one description field. It is an intro, a set of
    // titled bullet lists, and a closing block, and the requirements almost
    // always live in the lists. Reading only descriptionPlain loses them, and
    // the gate then judges a job on its introduction.
    const parts = [j.descriptionPlain ?? ''];
    for (const list of j.lists ?? []) {
      parts.push(String(list?.text ?? ''));
      parts.push(htmlToText(list?.content));
    }
    parts.push(j.additionalPlain ?? '');

    out.push(makePosting({
      source: `lever:${slug}`,
      company: name || slug,
      title: j.text ?? '',
      location: cats.location ?? '',
      url: j.hostedUrl || j.applyUrl || '',
      description: parts.filter(Boolean).join('\n\n').trim(),
      remote: foldRemote(j.workplaceType, cats.location),
      salaryRaw: cats.compensation ?? null,
      employmentType: cats.commitment ?? null,
      postedAt: isoDate(j.createdAt), // epoch milliseconds
    }));
  }
  return out;
}

export async function fetchLever(slug, name = null, opts = {}) {
  const data = await fetchJson(`${BASE}/${slug}`, { params: { mode: 'json' }, ...opts });
  return mapLever(data, slug, name);
}
