import { ATSError } from './http.js';
import { fetchGreenhouse } from './greenhouse.js';
import { fetchLever } from './lever.js';
import { fetchAshby } from './ashby.js';
import { fetchWorkable } from './workable.js';
import { fetchSmartRecruiters } from './smartrecruiters.js';
import { fetchWorkday } from './workday.js';

export { ATSError };

// The five that are addressed by a single slug.
export const FETCHERS = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workable: fetchWorkable,
  smartrecruiters: fetchSmartRecruiters,
};

export const PLATFORMS = [...Object.keys(FETCHERS), 'workday'];

/** How a board is named in logs and failure reports. */
export function boardLabel(target) {
  return target.slug ?? `${target.tenant}/${target.site}`;
}

/**
 * Fetch one board.
 *
 * `name` overrides the display company, and it matters more than it looks:
 * Lever and Ashby report only the slug, so without it every report says
 * "junipersquare" instead of "Juniper Square".
 *
 * Workday is addressed by tenant, host and site rather than a slug, so it
 * takes the whole target instead of a string.
 */
export async function fetchBoard(platform, target, name = null, opts = {}) {
  const key = String(platform).trim().toLowerCase();
  if (key === 'workday') {
    const board = typeof target === 'string'
      ? { tenant: target.split('/')[0], host: 'wd1', site: target.split('/')[1] }
      : target;
    if (!board?.tenant || !board?.site) {
      throw new ATSError('workday needs tenant, host and site; none of them can be guessed');
    }
    return fetchWorkday(board, name, opts);
  }
  const fetcher = FETCHERS[key];
  if (!fetcher) throw new ATSError(`unknown ATS platform: ${platform}`);
  return fetcher(target, name, opts);
}

/**
 * Fetch every target.
 *
 * One board's failure never aborts a run. Failures come back as data so the
 * caller can report them, because a crawl that stops at the eleventh of
 * forty-seven boards and says nothing is worse than one that finishes and
 * tells you which two were down. Boards skipped by `shouldStop` come back the
 * same way, for the same reason.
 */
export async function fetchAll(targets, opts = {}) {
  const postings = [];
  const failures = [];
  const stopped = [];
  for (const target of targets) {
    // `--limit 20` should mean twenty postings, not twenty postings after
    // crawling nine thousand. The check is between boards rather than inside
    // one because a board answers with its whole list in a single request;
    // there is no partial fetch to stop halfway through.
    if (opts.shouldStop?.(postings)) {
      stopped.push(boardLabel(target));
      continue;
    }
    const { platform, name = null } = target;
    const slug = boardLabel(target);
    try {
      const found = await fetchBoard(platform, target.slug ?? target, name, opts);
      postings.push(...found);
      opts.onBoard?.({ platform, slug, count: found.length });
    } catch (err) {
      failures.push({ platform, slug, error: String(err.message ?? err) });
      opts.onBoard?.({ platform, slug, count: 0, error: String(err.message ?? err) });
    }
  }
  return { postings, failures, stopped };
}
