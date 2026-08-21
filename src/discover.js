// Finding which ATS a company uses, and under what slug.
//
// Building the company list is the highest-leverage hour in this whole tool.
// This file exists so that hour is spent deciding which employers are worth
// watching, rather than hunting board tokens by hand.
//
// Two modes, and the second is the one that works: guess a slug and probe it
// across the platforms, or read a careers page and pull the slug out of its
// apply links. Guessing is cheap and often right; reading is slower and almost
// always right.

import { fetchBoard, FETCHERS } from './collectors/index.js';
import { parseWorkdayUrl } from './collectors/workday.js';
import { userAgent, TIMEOUT_MS } from './collectors/http.js';

/**
 * Apply-link shapes that betray which ATS sits behind a careers page.
 *
 * Written with String.raw rather than as literals with escaped backslashes,
 * because a `\b` or `\s` that survives one round of quoting and not the next
 * compiles into a regex that matches something else entirely and says nothing
 * about it.
 */
export const LINK_PATTERNS = [
  ['greenhouse', String.raw`(?:boards|job-boards)\.greenhouse\.io/(?:embed/job_board\?for=)?([a-z0-9_-]+)`],
  ['greenhouse', String.raw`boards-api\.greenhouse\.io/v1/boards/([a-z0-9_-]+)`],
  ['greenhouse', String.raw`gh_jid=\d+[^"']*?[?&]for=([a-z0-9_-]+)`],
  ['lever', String.raw`jobs\.(?:eu\.)?lever\.co/([a-z0-9_-]+)`],
  ['lever', String.raw`api\.lever\.co/v0/postings/([a-z0-9_-]+)`],
  ['ashby', String.raw`jobs\.ashbyhq\.com/([a-z0-9_.-]+)`],
  ['ashby', String.raw`api\.ashbyhq\.com/posting-api/job-board/([a-z0-9_.-]+)`],
  ['workable', String.raw`apply\.workable\.com/([a-z0-9_-]+)`],
  ['workable', String.raw`([a-z0-9_-]+)\.workable\.com`],
  ['recruitee', String.raw`([a-z0-9_-]+)\.recruitee\.com`],
  ['smartrecruiters', String.raw`jobs\.smartrecruiters\.com/(?:oneclick-ui/company/)?([A-Za-z0-9_-]+)`],
  ['smartrecruiters', String.raw`careers\.smartrecruiters\.com/([A-Za-z0-9_-]+)`],
  ['smartrecruiters', String.raw`api\.smartrecruiters\.com/v1/companies/([A-Za-z0-9_-]+)`],
].map(([platform, source]) => ({ platform, re: new RegExp(source, 'gi') }));

/** Path segments that are part of the URL shape, not the company's name. */
export const IGNORE_SLUGS = new Set(['embed', 'job_board', 'jobs', 'careers', 'www', 'api', 'company']);

/**
 * The platforms where an empty board proves nothing.
 *
 * SmartRecruiters answers HTTP 200 with an empty list for any slug, real or
 * invented: `Ubisoft` returns nothing and looks dead, `Ubisoft2` returns 271.
 * So a zero there is not evidence of anything and cannot be reported as a hit.
 * The other five return a real 404 for an unknown slug, which makes their zero
 * honest — "real board, nobody hiring today" is worth adding to a list.
 */
export const NEEDS_NONZERO = new Set(['smartrecruiters']);

/** Plausible slug spellings for a company name, best guess first. */
export function slugCandidates(name) {
  const base = String(name ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const words = base.split(/\s+/).filter(Boolean);
  const joined = words.join('');
  const out = [joined, words.join('-'), words[0] ?? joined, String(name ?? '').trim()];
  return [...new Set(out.filter(Boolean))];
}

/**
 * Try one slug against each platform.
 *
 * A live board with zero open roles still counts, everywhere except the
 * platforms above: the slug is right, the company just is not hiring today,
 * and that is exactly the company worth watching from tomorrow.
 */
export async function probe(slug, { platforms = Object.keys(FETCHERS), onResult = null, ...opts } = {}) {
  const hits = [];
  for (const platform of platforms) {
    if (!FETCHERS[platform]) continue;
    let postings;
    try {
      postings = await fetchBoard(platform, slug, null, opts);
    } catch (err) {
      onResult?.({ platform, slug, hit: false, error: String(err.message ?? err) });
      continue;
    }
    if (!postings.length && NEEDS_NONZERO.has(platform)) {
      onResult?.({ platform, slug, hit: false, error: 'empty, and this platform returns empty for any slug' });
      continue;
    }
    hits.push({ platform, slug, count: postings.length });
    onResult?.({ platform, slug, hit: true, count: postings.length });
  }
  return hits;
}

/** Every (platform, slug) pair an HTML page mentions, in page order. */
export function linksInPage(html) {
  const found = [];
  const seen = new Set();
  for (const { platform, re } of LINK_PATTERNS) {
    re.lastIndex = 0;
    for (const match of String(html ?? '').matchAll(re)) {
      const slug = match[1];
      if (!slug || IGNORE_SLUGS.has(slug.toLowerCase())) continue;
      const key = `${platform}:${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ platform, slug });
    }
  }
  return found;
}

async function getPage(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'User-Agent': opts.userAgent ?? userAgent() },
    signal: AbortSignal.timeout(opts.timeout ?? TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return { finalUrl: res.url ?? url, html: await res.text() };
}

/**
 * Read a careers page and verify what it names.
 *
 * A slug seen in a page is a claim, not a board. Every one found gets fetched
 * before it is reported, because careers pages carry stale links, links to a
 * parent company's board, and links belonging to whichever vendor built the
 * site. Reporting an unverified slug means it lands in a company list and
 * quietly returns nothing for a month.
 *
 * Workday is resolved separately and first. It is not addressed by a slug, so
 * none of the link patterns can find it, and it is the platform most likely to
 * be behind a careers page that simply redirects.
 */
export async function fromCareersUrl(url, { onResult = null, ...opts } = {}) {
  const { finalUrl, html } = await getPage(url, opts);

  // The redirect target is the reliable source: a careers URL that lands on
  // myworkdayjobs.com has just told you all three parts.
  const workday = parseWorkdayUrl(finalUrl) ?? parseWorkdayUrl(html);
  if (workday) {
    onResult?.({ platform: 'workday', slug: `${workday.tenant}/${workday.site}`, hit: true });
    return [{ platform: 'workday', board: workday, slug: `${workday.tenant}/${workday.site}`, count: null }];
  }

  const seen = linksInPage(html);
  if (!seen.length) return [];

  const verified = [];
  for (const { platform, slug } of seen) {
    // Case matters on SmartRecruiters and does not on the others, so a slug
    // scraped with capitals is worth trying twice before it is written off.
    for (const candidate of [...new Set([slug, slug.toLowerCase()])]) {
      let postings;
      try {
        postings = await fetchBoard(platform, candidate, null, opts);
      } catch {
        continue;
      }
      if (!postings.length && NEEDS_NONZERO.has(platform)) continue;
      verified.push({ platform, slug: candidate, count: postings.length });
      onResult?.({ platform, slug: candidate, hit: true, count: postings.length });
      break;
    }
  }

  for (const { platform, slug } of seen) {
    if (!verified.some((v) => v.platform === platform)) {
      onResult?.({ platform, slug, hit: false, error: 'named in the page, but the board did not answer' });
    }
  }
  return verified;
}

/**
 * Find a company's board, from either a name or a careers URL.
 *
 * With `all: false` the slug candidates stop at the first spelling that hits,
 * which is almost always the right one and saves four fetches per platform.
 */
export async function discover(target, { url = null, all = false, onResult = null, onProbe = null, ...opts } = {}) {
  const results = [];

  if (url) {
    results.push(...await fromCareersUrl(url, { onResult, ...opts }));
  }

  if (target && !results.length) {
    for (const candidate of slugCandidates(target)) {
      onProbe?.(candidate);
      const hits = await probe(candidate, { onResult, ...opts });
      results.push(...hits);
      if (hits.length && !all) break;
    }
  }

  return results;
}

/** The line a user pastes into `config/companies.yaml`. */
export function companiesYamlLine({ platform, slug, board, count }) {
  const entry = platform === 'workday' && board
    ? `{ platform: workday, tenant: ${board.tenant}, host: ${board.host}, site: ${board.site} }`
    : `{ platform: ${platform}, slug: ${slug} }`;
  return `  - ${entry}${count === null || count === undefined ? '' : `   # ${count} open`}`;
}
