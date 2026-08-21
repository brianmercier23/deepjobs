import { fetchJson } from './http.js';
import { makePosting } from '../lib/posting.js';
import { htmlToText } from '../lib/text.js';
import { foldRemote } from '../lib/remote.js';
import { isoDate } from '../lib/dates.js';

export const BASE = 'https://boards-api.greenhouse.io/v1/boards';

// Greenhouse puts everything a board owner wanted to add in a metadata array
// of {name, value} objects, so compensation and workplace type are only
// reachable by name, and the names are not standardized.
function metadata(job) {
  const out = {};
  for (const m of job.metadata ?? []) {
    if (m && typeof m === 'object') out[String(m.name ?? '').trim().toLowerCase()] = m.value;
  }
  return out;
}

/** Pure: raw board response to postings. Tested against a recorded fixture. */
export function mapGreenhouse(data, slug, name = null) {
  const out = [];
  for (const j of data?.jobs ?? []) {
    const meta = metadata(j);
    const location = j.location?.name ?? '';
    const workplace = meta['workplace type'] ?? meta.remote;
    out.push(makePosting({
      source: `greenhouse:${slug}`,
      company: name || j.company_name || slug,
      title: j.title ?? '',
      location,
      url: j.absolute_url ?? '',
      // content is entity-escaped HTML inside a JSON string, sometimes more
      // than once. htmlToText is what makes it readable.
      description: htmlToText(j.content),
      remote: foldRemote(workplace, location),
      salaryRaw: meta['salary range'] ?? meta.compensation ?? null,
      employmentType: meta['employment type'] ?? null,
      postedAt: isoDate(j.first_published ?? j.updated_at),
    }));
  }
  return out;
}

export async function fetchGreenhouse(slug, name = null, opts = {}) {
  const data = await fetchJson(`${BASE}/${slug}/jobs`, { params: { content: 'true' }, ...opts });
  return mapGreenhouse(data, slug, name);
}
