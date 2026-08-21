import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IGNORE_SLUGS,
  NEEDS_NONZERO,
  companiesYamlLine,
  fromCareersUrl,
  linksInPage,
  probe,
  slugCandidates,
} from '../src/discover.js';

// --------------------------------------------------------------------------
// slugs

test('a company name becomes the spellings a board slug actually takes', () => {
  // The third candidate is the one that hits for this company, which is the
  // whole reason there is a list rather than a single guess.
  assert.deepEqual(slugCandidates('Palantir Technologies'), ['palantirtechnologies', 'palantir-technologies', 'palantir', 'Palantir Technologies']);
  assert.deepEqual(slugCandidates('Stripe'), ['stripe', 'Stripe']);
  // Punctuation is dropped, not turned into a hyphen: no board slug has it.
  assert.deepEqual(slugCandidates('Bosch Group, Inc.'), ['boschgroupinc', 'bosch-group-inc', 'bosch', 'Bosch Group, Inc.']);
  assert.deepEqual(slugCandidates(''), []);
});

// --------------------------------------------------------------------------
// reading a page

const PAGE = `
  <a href="https://boards.greenhouse.io/acme">Careers</a>
  <a href="https://jobs.lever.co/othercorp/12345">Apply</a>
  <a href="https://boards.greenhouse.io/acme?gh_src=x">Same board again</a>
  <iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe>
  <a href="https://jobs.ashbyhq.com/some.company">Ashby</a>
`;

test('apply links give up the platform and the slug', () => {
  const found = linksInPage(PAGE);
  assert.deepEqual(found, [
    { platform: 'greenhouse', slug: 'acme' },
    { platform: 'lever', slug: 'othercorp' },
    { platform: 'ashby', slug: 'some.company' },
  ]);
});

test('the parts of a URL that are not a company name are ignored', () => {
  // Without this, the embed URL above contributes a board called "embed".
  for (const word of ['embed', 'job_board', 'careers']) assert.ok(IGNORE_SLUGS.has(word));
  assert.deepEqual(linksInPage('<a href="https://boards.greenhouse.io/embed/">x</a>'), []);
});

test('a page that names no board returns nothing rather than a guess', () => {
  assert.deepEqual(linksInPage('<html><body>We are hiring! Email us.</body></html>'), []);
  assert.deepEqual(linksInPage(null), []);
});

// --------------------------------------------------------------------------
// probing

// Board responses keyed by URL substring, so a probe can be run with no network.
function fakeBoards(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (key === undefined) {
      return { ok: false, status: 404, url: String(url), async text() { return 'Not Found'; } };
    }
    const body = routes[key];
    return { ok: true, status: 200, url: String(url), async json() { return body; }, async text() { return JSON.stringify(body); } };
  };
}

const GREENHOUSE_ONE = { jobs: [{ id: 1, title: 'Ops Analyst', absolute_url: 'https://x/1', content: '<p>Work here</p>', location: { name: 'Remote' }, updated_at: '2026-08-01T00:00:00Z' }] };

test('a slug that answers on one platform and not the others reports one hit', async () => {
  const hits = await probe('acme', {
    fetchImpl: fakeBoards({ 'boards-api.greenhouse.io/v1/boards/acme': GREENHOUSE_ONE }),
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].platform, 'greenhouse');
  assert.equal(hits[0].count, 1);
});

test('an empty board still counts, except where empty means nothing', async () => {
  // Four platforms 404 an unknown slug, so their zero is honest: real board,
  // nobody hiring today, and worth watching from tomorrow.
  const honest = await probe('quiet', {
    platforms: ['greenhouse'],
    fetchImpl: fakeBoards({ 'boards-api.greenhouse.io/v1/boards/quiet': { jobs: [] } }),
  });
  assert.deepEqual(honest, [{ platform: 'greenhouse', slug: 'quiet', count: 0 }]);

  // SmartRecruiters answers 200 with an empty list for any slug at all, so the
  // same response there is not evidence of a board.
  assert.ok(NEEDS_NONZERO.has('smartrecruiters'));
  const meaningless = await probe('invented', {
    platforms: ['smartrecruiters'],
    fetchImpl: fakeBoards({ 'api.smartrecruiters.com/v1/companies/invented': { totalFound: 0, content: [] } }),
  });
  assert.deepEqual(meaningless, []);
});

// --------------------------------------------------------------------------
// careers pages

test('a careers page that redirects to workday gives up all three parts', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: 'https://jll.wd1.myworkdayjobs.com/en-US/jllcareers',
    async text() { return '<html>redirected</html>'; },
  });
  const results = await fromCareersUrl('https://www.jll.com/en-us/careers', { fetchImpl });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].board, { tenant: 'jll', host: 'wd1', locale: 'en-US', site: 'jllcareers' });
  // The pasted line carries the three parts that cannot be guessed. Locale is
  // not one of them; it has a default and a wrong one does not 422.
  assert.equal(companiesYamlLine(results[0]), '  - { platform: workday, tenant: jll, host: wd1, site: jllcareers }');
});

test('a slug seen in a page is verified before it is reported', async () => {
  // Careers pages carry stale links, a parent company's board, and whatever
  // the agency that built the site left behind. Reporting one unchecked puts
  // a board in a company list that quietly returns nothing for a month.
  const fetchImpl = async (url) => {
    const s = String(url);
    if (s.includes('example.com')) {
      return { ok: true, status: 200, url: s, async text() { return PAGE; } };
    }
    if (s.includes('/boards/acme')) {
      return { ok: true, status: 200, url: s, async json() { return GREENHOUSE_ONE; } };
    }
    return { ok: false, status: 404, url: s, async text() { return 'Not Found'; } };
  };

  const misses = [];
  const results = await fromCareersUrl('https://example.com/careers', {
    fetchImpl,
    onResult: (r) => { if (!r.hit) misses.push(r); },
  });

  assert.deepEqual(results, [{ platform: 'greenhouse', slug: 'acme', count: 1 }]);
  assert.deepEqual(misses.map((m) => m.platform).sort(), ['ashby', 'lever']);
});

// --------------------------------------------------------------------------
// output

test('a hit renders as a line that can be pasted into the company list', () => {
  assert.equal(companiesYamlLine({ platform: 'ashby', slug: 'linear', count: 32 }), '  - { platform: ashby, slug: linear }   # 32 open');
  assert.equal(
    companiesYamlLine({ platform: 'workday', board: { tenant: 'jll', host: 'wd1', site: 'jllcareers' }, count: null }),
    '  - { platform: workday, tenant: jll, host: wd1, site: jllcareers }',
  );
});
