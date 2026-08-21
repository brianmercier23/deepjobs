#!/usr/bin/env node
// Re-record the collector fixtures from live boards.
//
//   node scripts/record-fixtures.js
//
// Fixtures are real responses, trimmed to a few postings, so the mapper tests
// run with no network and no API key. They are public job postings, which is
// why they are safe to commit.
//
// Run this when a board changes shape. If a mapper test fails right after a
// re-record, the board changed something, and that is the point: the tests are
// there to notice.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchJson } from '../src/collectors/http.js';
import { BASE as GH } from '../src/collectors/greenhouse.js';
import { BASE as LEVER } from '../src/collectors/lever.js';
import { BASE as ASHBY } from '../src/collectors/ashby.js';
import { BASE as WORKABLE } from '../src/collectors/workable.js';
import { BASE as SR } from '../src/collectors/smartrecruiters.js';
import { apiBase as workdayBase, PAGE as WD_PAGE } from '../src/collectors/workday.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const KEEP = 3;

function save(name, data) {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  process.stdout.write(`  ${name}.json\n`);
}

const TARGETS = {
  greenhouse: 'figma',
  lever: 'palantir',
  ashby: 'linear',
  workable: 'persado',
  smartrecruiters: 'Ubisoft2',
  workday: { tenant: 'jll', host: 'wd1', site: 'jllcareers' },
};

process.stdout.write('recording fixtures\n');

const gh = await fetchJson(`${GH}/${TARGETS.greenhouse}/jobs`, { params: { content: 'true' } });
save('greenhouse', { ...gh, jobs: (gh.jobs ?? []).slice(0, KEEP) });

const lever = await fetchJson(`${LEVER}/${TARGETS.lever}`, { params: { mode: 'json' } });
save('lever', lever.slice(0, KEEP));

const ashby = await fetchJson(`${ASHBY}/${TARGETS.ashby}`, { params: { includeCompensation: 'true' } });
save('ashby', { ...ashby, jobs: (ashby.jobs ?? []).slice(0, KEEP) });

const workable = await fetchJson(`${WORKABLE}/${TARGETS.workable}`, { params: { details: 'true' } });
save('workable', { ...workable, jobs: (workable.jobs ?? []).slice(0, KEEP) });

const srBase = `${SR}/${TARGETS.smartrecruiters}/postings`;
const sr = await fetchJson(srBase, { params: { limit: 100, offset: 0 } });
const rows = (sr.content ?? []).slice(0, KEEP);
save('smartrecruiters', { ...sr, content: rows, totalFound: rows.length });
// The list endpoint carries no body, so the detail shape needs its own fixture.
save('smartrecruiters-detail', await fetchJson(`${srBase}/${rows[0].id}`));

// Workday: a POST for the list, and a separate call for each description.
const wdBase = workdayBase(TARGETS.workday);
const wdList = await fetchJson(`${wdBase}/jobs`, {
  body: { appliedFacets: {}, limit: WD_PAGE, offset: 0, searchText: 'facilities manager' },
});
const wdRows = (wdList.jobPostings ?? []).slice(0, KEEP);
// Drop the facet tree: it is 90KB of filter options and nothing maps it.
save('workday', { total: wdList.total, jobPostings: wdRows });
save('workday-detail', await fetchJson(`${wdBase}${wdRows[0].externalPath}`));

// The zero that means "real board, nobody hiring today", as opposed to the
// SmartRecruiters zero that means nothing at all.
save('workable-empty', await fetchJson(`${WORKABLE}/veriff`, { params: { details: 'true' } }));

process.stdout.write('done\n');
