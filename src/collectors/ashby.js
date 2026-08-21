import { fetchJson } from './http.js';
import { makePosting } from '../lib/posting.js';
import { htmlToText } from '../lib/text.js';
import { foldRemote } from '../lib/remote.js';
import { isoDate } from '../lib/dates.js';

export const BASE = 'https://api.ashbyhq.com/posting-api/job-board';

/** Pure: raw board response to postings. Tested against a recorded fixture. */
export function mapAshby(data, slug, name = null) {
  const out = [];
  for (const j of data?.jobs ?? []) {
    // Ashby returns unlisted drafts alongside live postings.
    if (j.isListed === false) continue;

    const comp = j.compensation ?? {};
    const secondary = (j.secondaryLocations ?? [])
      .map((s) => String(s?.location ?? ''))
      .filter(Boolean);
    let location = j.location ?? '';
    if (secondary.length) location = `${location} / ${secondary.join(' / ')}`.replace(/^ \/ | \/ $/g, '');

    out.push(makePosting({
      source: `ashby:${slug}`,
      company: name || slug,
      title: j.title ?? '',
      location,
      url: j.jobUrl || j.applyUrl || '',
      description: j.descriptionPlain || htmlToText(j.descriptionHtml),
      remote: foldRemote(j.isRemote, j.workplaceType),
      salaryRaw: comp.scrapeableCompensationSalarySummary ?? comp.compensationTierSummary ?? null,
      employmentType: j.employmentType ?? null,
      postedAt: isoDate(j.publishedAt),
    }));
  }
  return out;
}

export async function fetchAshby(slug, name = null, opts = {}) {
  const data = await fetchJson(`${BASE}/${slug}`, { params: { includeCompensation: 'true' }, ...opts });
  return mapAshby(data, slug, name);
}
