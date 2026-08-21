import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  mapWorkday, parseWorkdayUrl, apiBase, publicUrl, discoverWorkday, PAGE,
} from '../src/collectors/workday.js';
import { fetchBoard, PLATFORMS } from '../src/collectors/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

const JLL = { tenant: 'jll', host: 'wd1', site: 'jllcareers' };

test('a workday board is three parts, none of them guessable', () => {
  assert.deepEqual(
    parseWorkdayUrl('https://jll.wd1.myworkdayjobs.com/jllcareers'),
    { tenant: 'jll', host: 'wd1', locale: null, site: 'jllcareers' },
  );
  // Some boards carry a locale segment before the site path.
  assert.deepEqual(
    parseWorkdayUrl('https://acme.wd5.myworkdayjobs.com/en-US/AcmeExternal'),
    { tenant: 'acme', host: 'wd5', locale: 'en-US', site: 'AcmeExternal' },
  );
  assert.equal(parseWorkdayUrl('https://boards.greenhouse.io/acme'), null);
  assert.equal(parseWorkdayUrl(null), null);
});

test('the site path stops before query junk', () => {
  // Scanning a page body means the match is surrounded by query strings and
  // escaped markup. A site path with a trailing "&" produces a 422 that reads
  // as a wrong board rather than as a parsing bug, which is how it hid.
  assert.equal(
    parseWorkdayUrl('href="https://jll.wd1.myworkdayjobs.com/jllcareers&amp;src=x"').site,
    'jllcareers',
  );
  assert.equal(
    parseWorkdayUrl('https://jll.wd1.myworkdayjobs.com/jllcareers?q=analyst').site,
    'jllcareers',
  );
});

test('the API base and the human URL are different addresses', () => {
  assert.equal(apiBase(JLL), 'https://jll.wd1.myworkdayjobs.com/wday/cxs/jll/jllcareers');
  assert.equal(
    publicUrl(JLL, '/job/Chicago-IL/Assistant-Facilities-Manager_REQ529767'),
    'https://jll.wd1.myworkdayjobs.com/jllcareers/job/Chicago-IL/Assistant-Facilities-Manager_REQ529767',
  );
});

test('the page size is 20 because 50 and 100 return 400', () => {
  assert.equal(PAGE, 20);
});

test('workday maps a real list plus a real detail body', () => {
  const list = fixture('workday');
  const rows = list.jobPostings;
  const detail = fixture('workday-detail').jobPostingInfo;
  const details = new Map([[rows[0].externalPath, detail]]);

  const postings = mapWorkday(rows, details, JLL, 'JLL');
  assert.equal(postings.length, 3);

  const [first] = postings;
  assert.equal(first.source, 'workday:jll/jllcareers');
  assert.equal(first.company, 'JLL');
  assert.ok(first.title.length > 0);
  assert.ok(first.description.length > 500, 'the detail call is where the body comes from');
  assert.match(first.postedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(first.employmentType, detail.timeType);
  assert.doesNotMatch(first.description, /<\/?(p|div|br|li)\b/i);
});

test('a posting with no detail still has a location, a URL and a remote flag', () => {
  // Details are capped, so most postings on a large tenant never get one.
  // What survives without a detail call is what the gate has to work with.
  const rows = fixture('workday').jobPostings;
  const postings = mapWorkday(rows, new Map(), JLL, 'JLL');
  for (const p of postings) {
    assert.ok(p.title.length > 0);
    assert.ok(p.location.length > 0, 'locationsText is on the list row');
    assert.match(p.url, /^https:\/\/jll\.wd1\.myworkdayjobs\.com\/jllcareers\/job\//);
    assert.ok([true, false, null].includes(p.remote));
    assert.equal(p.description, '');
    // postedOn is the phrase "Posted Today", not a date. A guessed date makes
    // a stale posting look fresh, so it stays null until the detail call.
    assert.equal(p.postedAt, null);
  }
});

test('remoteType is answered on the list row, for free', () => {
  const rows = [
    { title: 'A', externalPath: '/job/a', locationsText: 'Chicago, IL', remoteType: 'On-site' },
    { title: 'B', externalPath: '/job/b', locationsText: 'Remote, USA', remoteType: 'Remote' },
    { title: 'C', externalPath: '/job/c', locationsText: 'Chicago, IL' },
  ];
  const [a, b, c] = mapWorkday(rows, new Map(), JLL);
  assert.equal(a.remote, false);
  assert.equal(b.remote, true);
  // No remoteType and a location that says nothing is still an answer of
  // sorts: the board named a city.
  assert.equal(c.remote, false);
});

test('workday is addressed by tenant and site, not a slug', async () => {
  assert.ok(PLATFORMS.includes('workday'));
  await assert.rejects(
    () => fetchBoard('workday', { tenant: 'jll' }),
    /tenant, host and site/,
  );
});

test('discovery reads the three parts out of a redirect', async () => {
  const fetchImpl = async () => ({
    url: 'https://jll.wd1.myworkdayjobs.com/jllcareers',
    text: async () => '',
  });
  assert.deepEqual(
    await discoverWorkday('https://www.jll.com/careers', { fetchImpl }),
    { tenant: 'jll', host: 'wd1', locale: null, site: 'jllcareers' },
  );
});

test('discovery falls back to scanning the page body', async () => {
  // Some careers pages link to the board rather than redirecting to it.
  const fetchImpl = async () => ({
    url: 'https://www.acme.com/careers',
    text: async () => '<a href="https://acme.wd5.myworkdayjobs.com/en-US/External">Search jobs</a>',
  });
  const found = await discoverWorkday('https://www.acme.com/careers', { fetchImpl });
  assert.equal(found.tenant, 'acme');
  assert.equal(found.site, 'External');
});

test('discovery returns null rather than a guess when the page never names a board', async () => {
  // Measured against a real marketing careers site: 300KB of WordPress with
  // the actual job search another click in. A wrong guess here costs a 422
  // that looks like a dead board, so null is the honest answer and the user
  // pastes the board URL instead.
  const fetchImpl = async () => ({
    url: 'https://careers.example.com/',
    text: async () => '<html><body>Careers at Example</body></html>',
  });
  assert.equal(await discoverWorkday('https://careers.example.com', { fetchImpl }), null);
});
