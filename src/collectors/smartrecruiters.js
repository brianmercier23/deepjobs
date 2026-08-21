import { fetchJson, ATSError } from './http.js';
import { makePosting } from '../lib/posting.js';
import { htmlToText } from '../lib/text.js';
import { foldRemote } from '../lib/remote.js';
import { isoDate } from '../lib/dates.js';

export const BASE = 'https://api.smartrecruiters.com/v1/companies';
export const PAGE = 100;
// Descriptions cost one call each. Past this many, a company's postings still
// come through, just without a body: the gate can still judge them on title
// and location, and the scorer sees the shortfall rather than a silent gap.
export const MAX_DETAIL = 60;

const SECTION_ORDER = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'];

/** Pull the four description sections out of a detail response. */
export function mapDetail(detail) {
  const sections = detail?.jobAd?.sections ?? {};
  return SECTION_ORDER
    .map((key) => htmlToText(sections[key]?.text))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/**
 * The list endpoint carries no link a human can open. Its only URL field,
 * `ref`, points back at the API. postingUrl and applyUrl exist on the detail
 * response only, which means every posting past the detail cap would have no
 * URL at all, and a scored posting nobody can open is not a result.
 *
 * The public URL is derivable, and a bare id resolves without the title slug
 * SmartRecruiters usually appends. Verified 2026-08-20.
 */
export function postingUrl(row, slug) {
  const identifier = row.company?.identifier || slug;
  return `https://jobs.smartrecruiters.com/${identifier}/${row.id}`;
}

/**
 * Pure: list rows plus whatever details were fetched, to postings.
 *
 * @param {object[]} rows the `content` arrays, concatenated
 * @param {Map<string,{description?: string, url?: string}>} details by posting id
 */
export function mapSmartRecruiters(rows, details, slug, name = null) {
  const out = [];
  for (const j of rows ?? []) {
    const loc = j.location ?? {};
    const location = loc.fullLocation
      || [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
    // The board's own structured flags, folded with the location string.
    const flagged = loc.remote ? true : (loc.hybrid ? false : null);
    const detail = details?.get(String(j.id));

    out.push(makePosting({
      source: `smartrecruiters:${slug}`,
      company: name || j.company?.name || slug,
      title: j.name ?? '',
      location,
      url: detail?.url || postingUrl(j, slug),
      description: detail?.description ?? '',
      remote: foldRemote(flagged, location),
      employmentType: j.typeOfEmployment?.label ?? null,
      postedAt: isoDate(j.releasedDate),
    }));
  }
  return out;
}

/**
 * The list endpoint carries no description, so each posting needs a detail
 * call, capped at MAX_DETAIL per company.
 *
 * The trap worth knowing: SmartRecruiters answers HTTP 200 with an empty list
 * for any slug, real or invented. `Ubisoft` returns nothing and looks dead;
 * the real board is `Ubisoft2` and returns hundreds. A zero from this platform
 * proves nothing, which is why discovery treats it differently from the rest.
 */
export async function fetchSmartRecruiters(slug, name = null, opts = {}) {
  const base = `${BASE}/${slug}/postings`;
  const rows = [];
  let offset = 0;
  for (;;) {
    const page = await fetchJson(base, { params: { limit: PAGE, offset }, ...opts });
    const chunk = page?.content ?? [];
    rows.push(...chunk);
    offset += chunk.length;
    if (chunk.length < PAGE || offset >= Number(page?.totalFound ?? 0)) break;
  }

  const details = new Map();
  for (const j of rows.slice(0, MAX_DETAIL)) {
    try {
      const detail = await fetchJson(`${base}/${j.id}`, opts);
      details.set(String(j.id), {
        description: mapDetail(detail),
        url: detail.postingUrl || detail.applyUrl || null,
      });
    } catch (err) {
      // One missing body is not a reason to lose the other 59.
      if (!(err instanceof ATSError)) throw err;
    }
  }

  return mapSmartRecruiters(rows, details, slug, name);
}
