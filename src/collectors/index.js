import { ATSError } from './http.js';
import { fetchGreenhouse } from './greenhouse.js';
import { fetchLever } from './lever.js';
import { fetchAshby } from './ashby.js';
import { fetchWorkable } from './workable.js';
import { fetchSmartRecruiters } from './smartrecruiters.js';

export { ATSError };

export const FETCHERS = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workable: fetchWorkable,
  smartrecruiters: fetchSmartRecruiters,
};

export const PLATFORMS = Object.keys(FETCHERS);

/**
 * Fetch one board.
 *
 * `name` overrides the display company, and it matters more than it looks:
 * Lever and Ashby report only the slug, so without it every report says
 * "junipersquare" instead of "Juniper Square".
 */
export async function fetchBoard(platform, slug, name = null, opts = {}) {
  const key = String(platform).trim().toLowerCase();
  const fetcher = FETCHERS[key];
  if (!fetcher) throw new ATSError(`unknown ATS platform: ${platform}`);
  return fetcher(slug, name, opts);
}

/**
 * Fetch every target.
 *
 * One board's failure never aborts a run. Failures come back as data so the
 * caller can report them, because a crawl that stops at the eleventh of
 * forty-seven boards and says nothing is worse than one that finishes and
 * tells you which two were down.
 */
export async function fetchAll(targets, opts = {}) {
  const postings = [];
  const failures = [];
  for (const target of targets) {
    const { platform, slug, name = null } = target;
    try {
      const found = await fetchBoard(platform, slug, name, opts);
      postings.push(...found);
      opts.onBoard?.({ platform, slug, count: found.length });
    } catch (err) {
      failures.push({ platform, slug, error: String(err.message ?? err) });
      opts.onBoard?.({ platform, slug, count: 0, error: String(err.message ?? err) });
    }
  }
  return { postings, failures };
}
