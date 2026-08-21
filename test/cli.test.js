import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { main, parseArgs, USAGE } from '../src/cli.js';
import {
  CONFIG_FILES, ConfigError, initConfig, loadCompanies, loadEnv, loadGates,
} from '../src/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const temp = () => mkdtempSync(join(tmpdir(), 'deepjobs-'));

/** Capture what a command wrote, so nothing has to spawn a child process. */
function capture() {
  const out = [];
  const err = [];
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdout: () => out.join(''), stderr: () => err.join('') };
}

// --------------------------------------------------------------------------
// argument parsing

test('flags, valued options and positionals are told apart', () => {
  const { opts, positional } = parseArgs(['discover', '--url', 'https://x/careers', '--all']);
  assert.deepEqual(positional, ['discover']);
  assert.equal(opts.url, 'https://x/careers');
  assert.equal(opts.all, true);
});

test('--opt=value is the same as --opt value', () => {
  assert.equal(parseArgs(['--limit=20']).opts.limit, '20');
  assert.equal(parseArgs(['--limit', '20']).opts.limit, '20');
  // A URL with an = in its query must survive the split.
  assert.equal(parseArgs(['--url=https://x/jobs?for=acme&a=b']).opts.url, 'https://x/jobs?for=acme&a=b');
});

test('a misspelled option is refused instead of silently ignored', () => {
  assert.throws(() => parseArgs(['--dryrun']), ConfigError);
  assert.throws(() => parseArgs(['--limit']), /needs a value/);
});

// --------------------------------------------------------------------------
// dispatch

test('no command prints usage and succeeds', async () => {
  const io = capture();
  assert.equal(await main([], io), 0);
  assert.equal(io.stdout(), USAGE);
});

test('an unknown command exits 2 and says so on stderr', async () => {
  const io = capture();
  assert.equal(await main(['frobnicate'], io), 2);
  assert.match(io.stderr(), /unknown command "frobnicate"/);
});

test('setup explains that it is a skill rather than pretending to be a command', async () => {
  // It is listed in the usage text, so running it has to lead somewhere.
  const io = capture();
  assert.equal(await main(['setup'], io), 2);
  assert.match(io.stderr(), /Claude Code skill/);
});

test('a bad option value is an error message, not a stack trace', async () => {
  const io = capture();
  assert.equal(await main(['report', '--min', 'sixty'], io), 1);
  assert.match(io.stderr(), /deepjobs: --min needs a whole number/);
  assert.equal(io.stdout(), '');
});

// --------------------------------------------------------------------------
// init

test('init copies the examples and never overwrites without being asked', () => {
  const dir = join(temp(), 'config');

  const first = initConfig({ dir });
  assert.equal(first.written.length, CONFIG_FILES.length);
  for (const file of CONFIG_FILES) assert.ok(existsSync(join(dir, file.name)));

  // The rubric is the one file here that takes real work to write. Replacing
  // someone's silently is a mistake a tool gets to make once.
  writeFileSync(join(dir, 'rubric.md'), 'mine');
  const second = initConfig({ dir });
  assert.equal(second.written.length, 0);
  assert.equal(second.skipped.length, CONFIG_FILES.length);
  assert.equal(readFileSync(join(dir, 'rubric.md'), 'utf8'), 'mine');

  const forced = initConfig({ dir, force: true });
  assert.equal(forced.written.length, CONFIG_FILES.length);
  assert.notEqual(readFileSync(join(dir, 'rubric.md'), 'utf8'), 'mine');
});

// --------------------------------------------------------------------------
// config

test('the shipped example company list loads into crawlable targets', () => {
  const targets = loadCompanies(join(ROOT, 'examples/companies.example.yaml'));
  assert.ok(targets.length >= 8);
  assert.ok(targets.every((t) => t.platform));

  const workday = targets.find((t) => t.platform === 'workday');
  assert.equal(workday.tenant, 'jll');
  assert.equal(workday.site, 'jllcareers');
  // host defaults, because wd1 is the common case and the other two parts are
  // the ones nobody can guess.
  assert.equal(workday.host, 'wd1');
});

test('a company list missing what a platform needs fails at load, not mid-crawl', () => {
  const dir = temp();
  const path = join(dir, 'companies.yaml');

  writeFileSync(path, 'greenhouse:\n  - name: Acme\n');
  assert.throws(() => loadCompanies(path), /need a slug/);

  writeFileSync(path, 'workday:\n  - tenant: jll\n');
  assert.throws(() => loadCompanies(path), /tenant, host and site/);

  writeFileSync(path, '# nothing here\n');
  assert.throws(() => loadCompanies(path), /lists no boards/);
});

test('a missing config file names itself and says what to run', () => {
  assert.throws(() => loadGates(join(temp(), 'gates.yaml')), /deepjobs init/);
});

test('the shipped example gate config parses', () => {
  const gates = loadGates(join(ROOT, 'examples/gates.example.yaml'));
  assert.ok(gates.location);
});

// --------------------------------------------------------------------------
// .env

test('a .env file fills gaps in the environment and overrides nothing', () => {
  const dir = temp();
  const path = join(dir, '.env');
  writeFileSync(path, [
    '# a comment',
    'DEEPJOBS_TEST_NEW=from-file',
    'DEEPJOBS_TEST_EXISTING=from-file',
    "DEEPJOBS_TEST_QUOTED='quoted value'",
    'export DEEPJOBS_TEST_EXPORTED=also-fine',
    '',
  ].join('\n'));

  process.env.DEEPJOBS_TEST_EXISTING = 'from-shell';
  try {
    loadEnv(path);
    assert.equal(process.env.DEEPJOBS_TEST_NEW, 'from-file');
    assert.equal(process.env.DEEPJOBS_TEST_QUOTED, 'quoted value');
    assert.equal(process.env.DEEPJOBS_TEST_EXPORTED, 'also-fine');
    // A key exported in the shell wins over one left in a file months ago.
    assert.equal(process.env.DEEPJOBS_TEST_EXISTING, 'from-shell');
  } finally {
    for (const k of ['NEW', 'EXISTING', 'QUOTED', 'EXPORTED']) delete process.env[`DEEPJOBS_TEST_${k}`];
  }
});

test('no .env file is not an error', () => {
  assert.equal(loadEnv(join(temp(), '.env')), 0);
});

// --------------------------------------------------------------------------
// report

test('report on an empty database says so and exits non-zero', async () => {
  const io = capture();
  const code = await main(['report', '--db', join(temp(), 'seen.db')], io);
  assert.equal(code, 1);
  assert.match(io.stdout(), /`deepjobs run` first/);
});

test('stats reads a database that has never been run', async () => {
  const io = capture();
  assert.equal(await main(['stats', '--db', join(temp(), 'seen.db')], io), 0);
  assert.match(io.stdout(), /0 postings seen/);
});

// --------------------------------------------------------------------------
// the whole pipeline

/** One greenhouse board, served without a network. */
function fakeBoard(jobs) {
  return async (url) => {
    const s = String(url);
    if (s.includes('boards-api.greenhouse.io')) {
      return { ok: true, status: 200, url: s, async json() { return { jobs }; } };
    }
    return { ok: false, status: 404, url: s, async text() { return 'Not Found'; } };
  };
}

const JOBS = [
  {
    id: 1,
    title: 'Operations Analyst, Automation',
    absolute_url: 'https://example.com/1',
    location: { name: 'Remote - US' },
    updated_at: '2026-08-01T00:00:00Z',
    content: '<p>Take a manual reconciliation process apart and automate it. We use Claude and MCP tooling daily. Fully remote anywhere in the US.</p>'.repeat(4),
  },
  {
    id: 2,
    title: 'Director of Engineering',
    absolute_url: 'https://example.com/2',
    location: { name: 'Zurich, Switzerland' },
    updated_at: '2026-08-01T00:00:00Z',
    content: '<p>Lead a team of forty engineers on site in Zurich five days a week.</p>'.repeat(4),
  },
];

function scratchConfig() {
  const dir = temp();
  initConfig({ dir: join(dir, 'config') });
  return { configDir: join(dir, 'config'), db: join(dir, 'seen.db') };
}

test('run crawls, tags, gates and persists, and the funnel line adds up', async () => {
  const { configDir, db } = scratchConfig();
  writeFileSync(join(configDir, 'companies.yaml'), 'greenhouse:\n  - slug: acme\n');

  const io = capture();
  const code = await main(
    ['run', '--no-score', '--config', configDir, '--db', db],
    io,
    { fetchImpl: fakeBoard(JOBS) },
  );

  assert.equal(code, 0);
  assert.match(io.stdout(), /2 crawled {2}-> {2}2 new {2}-> {2}1 ai-forward {2}-> {2}1 gated {2}-> {2}not scored/);

  // The onsite director was gated out, and the tag fired on the one that names
  // its tooling. Both are the free stages doing their job before anything paid.
  const stats = capture();
  await main(['stats', '--db', db], stats);
  assert.match(stats.stdout(), /2 postings seen/);
  assert.match(stats.stdout(), /1 ai-forward/);
  assert.match(stats.stdout(), /1 passed the gate/);
  assert.match(stats.stdout(), /\$0\.00 spent/);
});

test('a second run of the same board finds nothing new', async () => {
  const { configDir, db } = scratchConfig();
  writeFileSync(join(configDir, 'companies.yaml'), 'greenhouse:\n  - slug: acme\n');
  const args = ['run', '--no-score', '--config', configDir, '--db', db];

  await main(args, capture(), { fetchImpl: fakeBoard(JOBS) });
  const io = capture();
  await main(args, io, { fetchImpl: fakeBoard(JOBS) });

  // This is the whole reason there is a database. A daily run should cost
  // nothing on the days nobody posted anything.
  assert.match(io.stdout(), /2 crawled {2}-> {2}0 new/);
});

test('--dry-run writes nothing at all', async () => {
  const { configDir, db } = scratchConfig();
  writeFileSync(join(configDir, 'companies.yaml'), 'greenhouse:\n  - slug: acme\n');

  const io = capture();
  await main(['run', '--no-score', '--dry-run', '--config', configDir, '--db', db], io, { fetchImpl: fakeBoard(JOBS) });
  assert.match(io.stdout(), /dry run: nothing was written/);

  const stats = capture();
  await main(['stats', '--db', db], stats);
  assert.match(stats.stdout(), /0 postings seen/);
});

test('a board that is down does not stop the crawl', async () => {
  const { configDir, db } = scratchConfig();
  writeFileSync(join(configDir, 'companies.yaml'), 'greenhouse:\n  - slug: acme\n  - slug: gone\n');

  const io = capture();
  const fetchImpl = async (url) => {
    const s = String(url);
    if (s.includes('/boards/acme')) return { ok: true, status: 200, url: s, async json() { return { jobs: JOBS }; } };
    return { ok: false, status: 500, url: s, async text() { return 'boom'; } };
  };
  assert.equal(await main(['run', '--no-score', '--config', configDir, '--db', db], io, { fetchImpl }), 0);

  assert.match(io.stdout(), /2 crawled/);
  assert.match(io.stdout(), /1 board failed/);
  // Which one failed has to reach the user, or a board can quietly die for
  // weeks while the funnel line still looks healthy.
  assert.match(io.stderr(), /greenhouse\/gone:/);
});

test('scoring is refused up front when there is no key, before the crawl', async () => {
  const { configDir, db } = scratchConfig();
  writeFileSync(join(configDir, 'companies.yaml'), 'greenhouse:\n  - slug: acme\n');

  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let crawled = false;
  try {
    const io = capture();
    const code = await main(['run', '--config', configDir, '--db', db], io, {
      envFile: join(temp(), 'no-such.env'),
      fetchImpl: async (url) => { crawled = true; return fakeBoard(JOBS)(url); },
    });
    assert.equal(code, 1);
    assert.match(io.stderr(), /ANTHROPIC_API_KEY/);
    // Failing at the end of a two-minute crawl for a missing key is a bad trade.
    assert.equal(crawled, false);
  } finally {
    if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
  }
});
