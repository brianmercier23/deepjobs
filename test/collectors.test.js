import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { mapGreenhouse } from '../src/collectors/greenhouse.js';
import { mapLever } from '../src/collectors/lever.js';
import { mapAshby } from '../src/collectors/ashby.js';
import { mapWorkable } from '../src/collectors/workable.js';
import { mapSmartRecruiters, mapDetail } from '../src/collectors/smartrecruiters.js';
import { PLATFORMS } from '../src/collectors/index.js';
import { isoDate } from '../src/lib/dates.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

// Real responses, trimmed. Refresh with `node scripts/record-fixtures.js`.
// A mapper test failing right after a refresh means a board changed shape,
// which is exactly what these are here to notice.

/** What every collector owes the rest of the pipeline, whatever board it read. */
function assertContract(p, { platform, slug }) {
  assert.equal(p.source, `${platform}:${slug}`);
  assert.match(p.hash, /^[0-9a-f]{64}$/);
  assert.ok(p.title.length > 0, 'title');
  assert.ok(p.url.startsWith('http'), `url: ${p.url}`);
  // The body is the entire point. A collector that returns everything except
  // the description has not collected anything worth gating.
  assert.ok(p.description.length > 200, `description too short: ${p.description.length}`);
  assert.ok([true, false, null].includes(p.remote), 'remote is tri-state');
  if (p.postedAt !== null) assert.match(p.postedAt, /^\d{4}-\d{2}-\d{2}$/);
  // No stray HTML made it through.
  assert.doesNotMatch(p.description, /<\/?(p|div|br|li|script)\b/i);
  assert.doesNotMatch(p.description, /&(amp|lt|gt|nbsp|quot);/);
}

test('greenhouse maps a real board response', () => {
  const postings = mapGreenhouse(fixture('greenhouse'), 'figma', 'Figma');
  assert.equal(postings.length, 3);
  for (const p of postings) {
    assertContract(p, { platform: 'greenhouse', slug: 'figma' });
    assert.equal(p.company, 'Figma');
  }
});

test('greenhouse reads compensation out of the metadata array', () => {
  // Greenhouse has no salary field. Board owners put it in a {name, value}
  // metadata array under whatever name they chose, so it is only reachable
  // by name and the names are not standardized.
  const data = {
    jobs: [{
      title: 'Analyst',
      absolute_url: 'https://example.com/1',
      location: { name: 'Remote' },
      content: '<p>Body</p>',
      metadata: [
        { name: 'Salary Range', value: '$120,000 - $150,000' },
        { name: 'Employment Type', value: 'Full-time' },
        { name: 'Workplace Type', value: 'Remote' },
      ],
    }],
  };
  const [p] = mapGreenhouse(data, 'acme');
  assert.equal(p.salaryRaw, '$120,000 - $150,000');
  assert.equal(p.employmentType, 'Full-time');
  assert.equal(p.remote, true);
  // Parsed into numbers by makePosting, so the gate never re-parses it.
  assert.equal(p.salaryMin, 120_000);
  assert.equal(p.salaryMax, 150_000);
});

test('lever maps a real board response', () => {
  const postings = mapLever(fixture('lever'), 'palantir', 'Palantir');
  assert.equal(postings.length, 3);
  for (const p of postings) assertContract(p, { platform: 'lever', slug: 'palantir' });
});

test('lever keeps the bullet lists, where the requirements live', () => {
  // Reading only descriptionPlain loses them, and the gate then judges a job
  // on its introduction.
  const data = [{
    text: 'Analyst',
    hostedUrl: 'https://example.com/1',
    categories: { location: 'Remote' },
    descriptionPlain: 'We are hiring.',
    lists: [{ text: 'Requirements', content: '<li>Five years of SQL</li>' }],
    additionalPlain: 'Equal opportunity employer.',
  }];
  const [p] = mapLever(data, 'acme');
  assert.match(p.description, /We are hiring/);
  assert.match(p.description, /Requirements/);
  assert.match(p.description, /Five years of SQL/);
  assert.match(p.description, /Equal opportunity/);
});

test('lever dates are epoch milliseconds', () => {
  const [p] = mapLever(
    [{ text: 'A', hostedUrl: 'https://x.co/1', categories: {}, createdAt: 1_711_324_800_000 }],
    'acme',
  );
  assert.equal(p.postedAt, '2024-03-25');
});

test('ashby maps a real board response', () => {
  const postings = mapAshby(fixture('ashby'), 'linear', 'Linear');
  assert.equal(postings.length, 3);
  for (const p of postings) assertContract(p, { platform: 'ashby', slug: 'linear' });
});

test('ashby drops unlisted drafts and joins secondary locations', () => {
  const data = {
    jobs: [
      { title: 'Draft', isListed: false, jobUrl: 'https://x.co/1', descriptionPlain: 'x' },
      {
        title: 'Live',
        isListed: true,
        jobUrl: 'https://x.co/2',
        descriptionPlain: 'body',
        location: 'New York',
        secondaryLocations: [{ location: 'Austin' }, { location: 'Remote' }],
      },
    ],
  };
  const postings = mapAshby(data, 'acme');
  assert.equal(postings.length, 1);
  assert.equal(postings[0].location, 'New York / Austin / Remote');
});

test('workable maps a real board response', () => {
  const postings = mapWorkable(fixture('workable'), 'persado');
  assert.equal(postings.length, 3);
  for (const p of postings) {
    assertContract(p, { platform: 'workable', slug: 'persado' });
    // The company name comes off the account, not the slug.
    assert.equal(p.company, 'Persado');
  }
});

test('workable stitches description, requirements and benefits', () => {
  const data = {
    name: 'Acme',
    jobs: [{
      title: 'Analyst',
      shortlink: 'https://x.co/1',
      city: 'Austin',
      state: 'TX',
      country: 'United States',
      description: '<p>What you will do.</p>',
      requirements: '<p>Five years of SQL.</p>',
      benefits: '<p>Health cover.</p>',
      telecommuting: true,
    }],
  };
  const [p] = mapWorkable(data, 'acme');
  assert.equal(p.location, 'Austin, TX, United States');
  assert.equal(p.remote, true);
  assert.match(p.description, /What you will do/);
  assert.match(p.description, /Five years of SQL/);
  assert.match(p.description, /Health cover/);
});

test('an empty workable board is an honest zero', () => {
  // Workable 404s an unknown slug, so a real board returning no jobs means
  // exactly that: nobody is hiring today. The opposite of SmartRecruiters.
  const data = fixture('workable-empty');
  assert.ok(data.name, 'a real board still names itself');
  assert.equal(mapWorkable(data, 'veriff').length, 0);
});

test('smartrecruiters maps a real list plus a real detail body', () => {
  const list = fixture('smartrecruiters');
  const rows = list.content;
  const detail = fixture('smartrecruiters-detail');
  const details = new Map([[String(rows[0].id), {
    description: mapDetail(detail),
    url: detail.postingUrl,
  }]]);
  const postings = mapSmartRecruiters(rows, details, 'Ubisoft2', 'Ubisoft');

  assert.equal(postings.length, 3);
  assert.equal(postings[0].company, 'Ubisoft');
  assertContract(postings[0], { platform: 'smartrecruiters', slug: 'Ubisoft2' });
  // Past the detail cap a posting still comes through, just without a body.
  assert.equal(postings[1].description, '');
  assert.ok(postings[1].title.length > 0);
});

test('smartrecruiters postings always have a URL a human can open', () => {
  // The list endpoint has no such field: its only URL, `ref`, points back at
  // the API. Without deriving one, every posting past the detail cap would be
  // scored and then be unopenable.
  const rows = fixture('smartrecruiters').content;
  const postings = mapSmartRecruiters(rows, new Map(), 'Ubisoft2', 'Ubisoft');
  for (const p of postings) {
    assert.match(p.url, /^https:\/\/jobs\.smartrecruiters\.com\/Ubisoft2\/\d+$/);
  }
  // A real detail URL wins over the derived one when there is one.
  assert.equal(
    mapSmartRecruiters(
      [{ id: '1', name: 'A', company: { identifier: 'Acme' } }],
      new Map([['1', { url: 'https://jobs.smartrecruiters.com/Acme/1-analyst' }]]),
      'Acme',
    )[0].url,
    'https://jobs.smartrecruiters.com/Acme/1-analyst',
  );
});

test('smartrecruiters detail sections are joined in reading order', () => {
  const detail = {
    jobAd: {
      sections: {
        jobDescription: { text: '<p>The role.</p>' },
        companyDescription: { text: '<p>The company.</p>' },
        qualifications: { text: '<p>The requirements.</p>' },
      },
    },
  };
  assert.equal(mapDetail(detail), 'The company.\n\nThe role.\n\nThe requirements.');
  assert.equal(mapDetail({}), '');
});

test('every collector survives an empty or malformed response', () => {
  // A board that returns something unexpected should yield no postings, not
  // throw and take the other forty-six boards down with it.
  for (const [fn, empty] of [
    [mapGreenhouse, {}], [mapGreenhouse, { jobs: null }],
    [mapLever, null], [mapLever, []],
    [mapAshby, {}], [mapWorkable, {}],
  ]) {
    assert.deepEqual(fn(empty, 'acme'), []);
  }
  assert.deepEqual(mapSmartRecruiters(null, new Map(), 'acme'), []);
});

test('the platform registry is the five that are wired up', () => {
  assert.deepEqual(PLATFORMS.sort(), ['ashby', 'greenhouse', 'lever', 'smartrecruiters', 'workable']);
});

test('isoDate handles every shape the boards send', () => {
  assert.equal(isoDate('2026-08-20'), '2026-08-20');
  assert.equal(isoDate('2026-08-20T14:33:00Z'), '2026-08-20');
  assert.equal(isoDate('2026-08-20T14:33:00+02:00'), '2026-08-20');
  assert.equal(isoDate(1_711_324_800_000), '2024-03-25');
  assert.equal(isoDate('2026/08/20'), '2026-08-20');
  assert.equal(isoDate('20-08-2026'), '2026-08-20');
  assert.equal(isoDate(null), null);
  assert.equal(isoDate(''), null);
  assert.equal(isoDate('sometime soon'), null);
});
