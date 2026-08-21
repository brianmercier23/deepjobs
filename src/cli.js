// The command line. Everything here is assembly: the decisions all live in the
// modules this calls.
//
// Two conventions worth knowing. Progress goes to stderr and results go to
// stdout, so `deepjobs report --json | jq` works while a crawl is still
// narrating itself. And nothing calls process.exit; commands return an exit
// code, which is what lets the tests run them in-process.

import { join } from 'node:path';

import { VERSION } from './index.js';
import { fetchAll, boardLabel } from './collectors/index.js';
import { applyGate } from './gate.js';
import { loadSignals, tagAll } from './tag.js';
import { loadRubric, createClient, scoreAll, ScoreError } from './score.js';
import { discover, companiesYamlLine } from './discover.js';
import {
  ConfigError, PACKAGE_ROOT, configPath, initConfig, installSkill, loadCompanies, loadEnv,
  loadGates,
} from './config.js';
import {
  openDb, recordGate, recordPostings, recordScore, report, splitNew, stats,
  touchSeen, upsertBoard,
} from './db.js';

export const USAGE = `deepjobs ${VERSION}

  A job search engine that reads the whole description, not the title.

Usage
  deepjobs init                       write config/ from examples/
  deepjobs setup                      install the interview skill for Claude Code
  deepjobs run [options]              collect, dedupe, tag, gate, score
  deepjobs discover <name|--url>      find a company's board slug
  deepjobs report [options]           list what scored well
  deepjobs stats                      what is in the database

Run options
  --dry-run          collect, tag and gate, write nothing (still reads the
                     database, so already-seen postings are skipped)
  --limit <n>        stop after n new postings
  --no-score         skip the LLM stage entirely (free)
  --db <path>        database file (default data/seen.db)
  --config <dir>     config directory (default config/), for a second search

Discover options
  --url <url>        read a careers page instead of guessing a slug
  --all              try every slug spelling, not just up to the first hit

Report options
  --min <n>          only postings scoring at or above n (default 60)
  --ai-forward       only postings tagged ai-forward
  --limit <n>        show at most n
  --json             machine-readable output

Scoring is the only stage that costs money, and it needs ANTHROPIC_API_KEY in
the environment or in a .env file. Everything else runs for nothing.
`;

const KNOWN = new Set(['init', 'setup', 'run', 'discover', 'report', 'stats']);

const FLAGS = new Set(['dry-run', 'no-score', 'ai-forward', 'all', 'json', 'force']);
const VALUED = new Set(['limit', 'min', 'db', 'url', 'config']);

/** A small parser, because argv shapes are exactly where a dependency is not worth it. */
export function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inlineValue] = arg.slice(2).split(/=(.*)/s);
    if (FLAGS.has(name)) {
      opts[name] = true;
    } else if (VALUED.has(name)) {
      const value = inlineValue ?? argv[++i];
      if (value === undefined) throw new ConfigError(`--${name} needs a value`);
      opts[name] = value;
    } else {
      throw new ConfigError(`unknown option --${name}`);
    }
  }
  return { opts, positional };
}

function integer(value, name) {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`--${name} needs a whole number, got "${value}"`);
  return n;
}

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// --------------------------------------------------------------------------
// init

function cmdInit(opts, io) {
  const dir = opts.config ?? 'config';
  const { written, skipped } = initConfig({ dir, force: opts.force });
  for (const file of written) io.out(`wrote    ${dir}/${file.name}  - ${file.what}\n`);
  for (const file of skipped) io.out(`kept     ${dir}/${file.name}  - already there, --force to replace\n`);
  if (written.length) {
    io.out('\nThe example rubric is written for a fictional person, so a run works cold.\n');
    io.out('Replace it with your own, or run `deepjobs setup` to be interviewed into one.\n');
  }
  return 0;
}

// --------------------------------------------------------------------------
// setup

/**
 * `setup` is an interview, and an interview needs someone to run it.
 *
 * The skill ships inside the package and a package is not somewhere Claude
 * Code looks, so this copies it into `.claude/skills/` in the working
 * directory rather than printing a path and hoping.
 */
function cmdSetup(io) {
  const { target, installed } = installSkill();
  io.out(`${installed ? 'installed' : 'already installed'}  ${target}\n\n`);
  io.out('Open this directory in Claude Code and ask it to set up deepjobs.\n');
  io.out('It reads your resume if you offer one, asks six questions, and writes\n');
  io.out('config/rubric.md, config/gates.yaml and config/companies.yaml from the\n');
  io.out('answers - verifying every board slug with `deepjobs discover` first,\n');
  io.out('because a guessed slug does not error, it just returns nothing.\n\n');
  io.out('Without Claude Code: run `deepjobs init` and edit the three files by hand.\n');
  io.out(`The interview is readable prose either way: ${target}\n`);
  return 0;
}

// --------------------------------------------------------------------------
// run

async function cmdRun(opts, io, deps = {}) {
  // A key exported in the shell wins; a .env in the working directory fills the
  // gap. `deps.envFile` exists so the tests can point at nothing and be sure a
  // developer's own key is not what made them pass.
  loadEnv(deps.envFile ?? '.env');
  const configDir = opts.config ?? 'config';
  const limit = integer(opts.limit, 'limit');
  const dryRun = Boolean(opts['dry-run']);
  const scoring = !opts['no-score'];

  const targets = loadCompanies(configPath('companies.yaml', configDir));
  const gates = loadGates(configPath('gates.yaml', configDir));
  const signals = loadSignals(join(PACKAGE_ROOT, 'signals/ai-forward.yaml'));

  // The rubric and the key are checked before the crawl, not after it. Failing
  // at the end of a two-minute crawl for a missing file is a bad trade.
  let rubric = null;
  let client = null;
  if (scoring) {
    rubric = loadRubric(configPath('rubric.md', configDir));
    client = await createClient();
  }

  const db = openDb(opts.db ?? 'data/seen.db');

  io.err(`crawling ${plural(targets.length, 'board')}\n`);
  const { postings, failures, stopped } = await fetchAll(targets, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    onBoard: ({ platform, slug, count, error }) => {
      io.err(error
        ? `  ${platform}/${slug}: ${error}\n`
        : `  ${platform}/${slug}: ${count}\n`);
    },
    // Counting *new* postings, not all of them: on the tenth run of the day
    // the first board is entirely postings already seen, and a limit that
    // counted those would stop the crawl having found nothing.
    shouldStop: limit ? (found) => splitNew(db, found).length >= limit : null,
  });
  if (stopped.length) io.err(`  --limit reached, ${plural(stopped.length, 'board')} not crawled\n`);

  if (!dryRun) {
    const counts = new Map();
    for (const p of postings) counts.set(p.source, (counts.get(p.source) ?? 0) + 1);
    for (const target of targets) {
      const slug = boardLabel(target);
      const failure = failures.find((f) => f.slug === slug && f.platform === target.platform);
      upsertBoard(db, {
        platform: target.platform,
        slug,
        name: target.name ?? null,
        parent: target.parent ?? null,
        lastOk: failure ? null : new Date().toISOString(),
        lastError: failure?.error ?? null,
        lastCount: failure ? null : (counts.get(`${target.platform}:${slug}`) ?? 0),
      });
    }
  }

  const fresh = splitNew(db, postings);
  if (!dryRun) touchSeen(db, postings);

  const batch = limit ? fresh.slice(0, limit) : fresh;
  const { tagged, aiForward } = tagAll(batch, signals);
  const { passed, rejected, reasons } = applyGate(tagged, gates);

  if (!dryRun) {
    recordPostings(db, [...passed, ...rejected.map((r) => r.posting)]);
    for (const p of passed) recordGate(db, p.hash, { result: 'pass', flags: p.flags });
    for (const r of rejected) {
      recordGate(db, r.posting.hash, { result: 'reject', reason: r.reason, flags: r.flags });
    }
  }

  let scored = [];
  let usage = null;
  if (scoring && passed.length) {
    io.err(`scoring ${plural(passed.length, 'posting')}\n`);
    const result = await scoreAll(passed, {
      rubric,
      client,
      onProgress: ({ done, total, usage: u }) => {
        if (done % 25 === 0 || done === total) {
          io.err(`  ${done}/${total}  ~$${u.costUsd.toFixed(3)}\n`);
        }
      },
      onError: (err) => io.err(`  skipped: ${err.message}\n`),
    });
    scored = result.scores;
    usage = result.usage;
    if (!dryRun) for (const score of scored) recordScore(db, score.hash, score);
  }

  // The funnel line. Every number in it is the input to the next stage, which
  // is the only way to see at a glance where a run actually spent itself.
  io.out(`\n${[
    `${postings.length.toLocaleString('en-US')} crawled`,
    `${fresh.length.toLocaleString('en-US')} new`,
    // Without this the line reads "566 new -> 2 gated" on a limited run and
    // looks like the gate rejected 564 postings it never saw.
    ...(batch.length === fresh.length ? [] : [`${batch.length.toLocaleString('en-US')} taken`]),
    `${aiForward.toLocaleString('en-US')} ai-forward`,
    `${passed.length.toLocaleString('en-US')} gated`,
    scoring ? `${scored.length.toLocaleString('en-US')} scored` : 'not scored',
  ].join('  ->  ')}\n`);

  if (failures.length) io.out(`${plural(failures.length, 'board')} failed\n`);
  if (usage) io.out(`${usage.summary()}\n`);
  if (dryRun) io.out('dry run: nothing was written\n');

  const top = scored.filter((s) => s.overall >= 60).sort((a, b) => b.overall - a.overall);
  if (top.length) {
    const byHash = new Map(passed.map((p) => [p.hash, p]));
    io.out(`\n${plural(top.length, 'posting')} scored 60 or better:\n`);
    for (const score of top.slice(0, 10)) {
      const p = byHash.get(score.hash);
      io.out(`  ${String(score.overall).padStart(3)}  ${p.company} - ${p.title}\n`);
    }
    if (!dryRun) io.out('\n`deepjobs report` for the rest.\n');
  } else if (scoring) {
    const reason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
    io.out(reason
      ? `nothing scored 60 or better. Most postings were rejected for: ${reason[0]}\n`
      : 'nothing scored 60 or better.\n');
  }

  return 0;
}

// --------------------------------------------------------------------------
// discover

async function cmdDiscover(opts, positional, io, deps = {}) {
  const name = positional[0] ?? null;
  if (!name && !opts.url) throw new ConfigError('give a company name or --url <careers page>');

  if (opts.url) io.err(`reading ${opts.url}\n`);
  const results = await discover(name, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    url: opts.url ?? null,
    all: Boolean(opts.all),
    onProbe: (slug) => io.err(`probing "${slug}"\n`),
    onResult: ({ platform, slug, hit, count, error }) => {
      io.err(hit
        ? `  HIT   ${platform.padEnd(16)} ${String(slug).padEnd(26)} ${count ?? ''}\n`
        : `  miss  ${platform.padEnd(16)} ${String(slug).padEnd(26)} ${error ?? ''}\n`);
    },
  });

  if (!results.length) {
    io.out('No board found.\n\n');
    io.out('Many careers pages load their board in an iframe or through JavaScript,\n');
    io.out('so nothing names it in the page source. Open the page, click Apply, and\n');
    io.out('read the slug out of the URL you land on.\n');
    return 1;
  }

  io.out('\nAdd to config/companies.yaml, under its platform:\n');
  for (const result of results) io.out(`${companiesYamlLine(result)}\n`);
  return 0;
}

// --------------------------------------------------------------------------
// report

function cmdReport(opts, io) {
  const db = openDb(opts.db ?? 'data/seen.db');
  const rows = report(db, {
    minScore: integer(opts.min, 'min') ?? 60,
    aiForwardOnly: Boolean(opts['ai-forward']),
  });
  const limit = integer(opts.limit, 'limit');
  const shown = limit ? rows.slice(0, limit) : rows;

  if (opts.json) {
    // The description is deliberately dropped. It is the largest field by an
    // order of magnitude and a report is a summary; anyone who wants the body
    // has the URL, and the database still has it.
    io.out(`${JSON.stringify(shown.map(({ description, ...rest }) => rest), null, 2)}\n`);
    return shown.length ? 0 : 1;
  }

  if (!shown.length) {
    io.out('Nothing scored at or above that. `deepjobs run` first, or lower --min.\n');
    return 1;
  }

  for (const row of shown) {
    io.out(`${String(row.overall).padStart(3)}  ${row.band.padEnd(8)}  ${row.company} - ${row.title}\n`);
    io.out(`     ${row.location || '(location not stated)'}${row.aiForward ? '  [ai-forward]' : ''}\n`);
    if (row.rationale) io.out(`     ${row.rationale}\n`);
    io.out(`     ${row.url}\n\n`);
  }
  if (limit && rows.length > shown.length) {
    io.out(`${rows.length - shown.length} more above --min. Raise --limit to see them.\n`);
  }
  return 0;
}

// --------------------------------------------------------------------------
// stats

function cmdStats(opts, io) {
  const row = stats(openDb(opts.db ?? 'data/seen.db'));
  io.out([
    `${row.total.toLocaleString('en-US')} postings seen`,
    `${row.ai_forward.toLocaleString('en-US')} ai-forward`,
    `${row.gate_passed.toLocaleString('en-US')} passed the gate`,
    `${row.scored.toLocaleString('en-US')} scored`,
    `${row.with_verdict.toLocaleString('en-US')} with your own verdict`,
    `$${Number(row.cost_usd).toFixed(2)} spent`,
  ].join('\n') + '\n');
  return 0;
}

// --------------------------------------------------------------------------

/**
 * Run one command.
 *
 * `io` is injected so the tests can capture output instead of parsing a child
 * process, and so a caller embedding this can send it somewhere else.
 */
export async function main(argv, io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
}, deps = {}) {
  const command = argv[0];

  if (!command || ['--help', '-h', 'help'].includes(command)) {
    io.out(USAGE);
    return 0;
  }
  if (['--version', '-v', 'version'].includes(command)) {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (!KNOWN.has(command)) {
    io.err(`deepjobs: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }

  try {
    const { opts, positional } = parseArgs(argv.slice(1));
    switch (command) {
      case 'init': return cmdInit(opts, io);
      case 'run': return await cmdRun(opts, io, deps);
      case 'discover': return await cmdDiscover(opts, positional, io, deps);
      case 'report': return cmdReport(opts, io);
      case 'stats': return cmdStats(opts, io);
      case 'setup': return cmdSetup(io);
      default: return 2;
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ScoreError) {
      io.err(`deepjobs: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
