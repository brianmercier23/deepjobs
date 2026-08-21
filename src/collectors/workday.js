// Workday, the sixth platform and the one that unlocks the large employers
// the other five never see.
//
// It is also the least like the others. The search endpoint is a POST, the
// page size is capped at 20, the list rows carry no description and no real
// date, and a board's address has three separate parts that cannot be guessed.

import { fetchJson, ATSError } from './http.js';
import { makePosting } from '../lib/posting.js';
import { htmlToText } from '../lib/text.js';
import { foldRemote } from '../lib/remote.js';
import { isoDate } from '../lib/dates.js';

// 20 is not a preference. 50 and 100 both return HTTP 400.
export const PAGE = 20;
// Descriptions cost one call each and a large tenant advertises thousands of
// roles, so the sane way to use this platform is a searchText filter plus a
// cap, not a full crawl.
export const MAX_DETAIL = 60;
export const MAX_LIST = 400;

/**
 * A Workday board is three parts, and a wrong site path returns HTTP 422 even
 * when the tenant is real, so none of them can be guessed.
 *
 *   https://jll.wd1.myworkdayjobs.com/jllcareers
 *          ^^^  ^^^                   ^^^^^^^^^^
 *          tenant host                site
 */
// The site path stops at anything that cannot be part of it. Scanning a page
// body rather than a clean redirect means the match is usually surrounded by
// query strings, HTML attributes and escaped markup, and a site path with a
// stray "&" on the end produces a 422 that looks like a wrong board.
const WORKDAY_URL = /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:([a-z]{2}-[A-Z]{2})\/)?([a-zA-Z0-9_-]+)/;

export function parseWorkdayUrl(url) {
  const m = WORKDAY_URL.exec(String(url ?? ''));
  if (!m) return null;
  return {
    tenant: m[1].toLowerCase(),
    host: m[2].toLowerCase(),
    locale: m[3] ?? null,
    site: m[4],
  };
}

export function apiBase({ tenant, host, site }) {
  return `https://${tenant}.${host}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
}

export function publicUrl(board, externalPath) {
  return `https://${board.tenant}.${board.host}.myworkdayjobs.com/${board.site}${externalPath ?? ''}`;
}

/**
 * Pure: list rows plus whatever details were fetched, to postings.
 *
 * The list row's `postedOn` is a human phrase ("Posted Today", "Posted 30+
 * Days Ago"), not a date, so postedAt comes from the detail call's startDate
 * or stays null. A guessed date is worse than no date: it makes a stale
 * posting look fresh.
 *
 * @param {Map<string,object>} details keyed by externalPath
 */
export function mapWorkday(rows, details, board, name = null) {
  const out = [];
  for (const j of rows ?? []) {
    const info = details?.get(j.externalPath) ?? null;
    const location = info?.location || j.locationsText || '';
    const description = info?.jobDescription ? htmlToText(info.jobDescription) : '';

    out.push(makePosting({
      source: `workday:${board.tenant}/${board.site}`,
      company: name || board.tenant,
      title: j.title ?? info?.title ?? '',
      location,
      url: info?.externalUrl || publicUrl(board, j.externalPath),
      description,
      // remoteType is structured and present on the list row, so this is one
      // of the few boards that answers the remote question for free.
      remote: foldRemote(j.remoteType ?? info?.remoteType, location),
      employmentType: info?.timeType ?? null,
      postedAt: isoDate(info?.startDate),
    }));
  }
  return out;
}

/**
 * Fetch one Workday board.
 *
 * `searchText` is worth using and no other platform offers it: the filtering
 * happens server-side, so a term like "automation" turns a 2,000-posting
 * tenant into something worth paying detail calls for.
 *
 * @param {{tenant: string, host: string, site: string, searchText?: string}} board
 */
export async function fetchWorkday(board, name = null, opts = {}) {
  const base = apiBase(board);
  const searchText = board.searchText ?? opts.searchText ?? '';
  const maxList = opts.maxList ?? MAX_LIST;
  const maxDetail = opts.maxDetail ?? MAX_DETAIL;

  const rows = [];
  let offset = 0;
  for (;;) {
    const page = await fetchJson(`${base}/jobs`, {
      ...opts,
      body: { appliedFacets: {}, limit: PAGE, offset, searchText },
    });
    const chunk = page?.jobPostings ?? [];
    rows.push(...chunk);
    offset += chunk.length;
    // `total` maxes out at 2000 whatever the real figure is, so it is a
    // stopping hint and not a count to report.
    const total = Number(page?.total ?? 0);
    if (chunk.length < PAGE || offset >= total || rows.length >= maxList) break;
  }

  const details = new Map();
  for (const j of rows.slice(0, maxDetail)) {
    try {
      const detail = await fetchJson(`${base}${j.externalPath}`, opts);
      if (detail?.jobPostingInfo) details.set(j.externalPath, detail.jobPostingInfo);
    } catch (err) {
      // One unreachable posting is not a reason to lose the board.
      if (!(err instanceof ATSError)) throw err;
    }
  }

  return mapWorkday(rows, details, board, name);
}

/**
 * Resolve a company's careers page to its Workday board.
 *
 * The three parts are not guessable and a wrong site path 422s even with a
 * real tenant, so the only reliable way to get them is to let the careers URL
 * redirect and read the address it lands on. Falls back to scanning the page
 * body, because some careers pages link to Workday rather than redirecting.
 */
export async function discoverWorkday(careersUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(careersUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': opts.userAgent ?? 'deepjobs/0.1' },
    signal: AbortSignal.timeout(opts.timeout ?? 25_000),
  });

  const fromRedirect = parseWorkdayUrl(res.url);
  if (fromRedirect) return fromRedirect;

  const body = await res.text();
  return parseWorkdayUrl(body);
}
