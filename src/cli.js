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
import { loadRubric, createClient, scoreAll, normalizeCaps, ScoreError } from './score.js';
import { discover, companiesYamlLine } from './discover.js';
import { normalizeNotify, buildRequest, sendLeads } from './notify.js';
import {
  ConfigError, PACKAGE_ROOT, configPath, initConfig, installSkill, loadCompanies, loadEnv,
  loadGates, loadNotify,
} from './config.js';
import {
  findByHashPrefix, openDb, pendingLeads, recordGate, recordNotified, recordPostings, recordScore, report, setVerdict,
  splitNew, stats, touchSeen, unscoredPassed, unscoredPassedCount, upsertBoard,
} from './db.js';

export const USAGE = `deepjobs ${VERSION}

  A job search engine that reads the whole description, not the title.

Usage
  deepjobs init                       write config/ from examples/
  deepjobs setup                      install the interview skill for Claude Code
  deepjobs run [options]              collect, dedupe, tag, gate, score
  deepjobs discover <name|--url>      find a company's board slug
  deepjobs report [options]           list what scored well
  deepjobs mark <id> yes|no|maybe     record what you thought of one
  deepjobs notify [options]           send new leads to a webhook, once each
  deepjobs stats                      what is in the database

Run options
  --dry-run          collect, tag and gate, write nothing (still reads the
                     database, so already-seen postings are skipped)
  --limit <n>        stop after n new postings
  --no-score         skip the LLM stage entirely (free)
  --rescore-unscored also score postings that passed the gate on an earlier run
                     but were never scored, usually because that run lost its
                     API key or its credit balance partway through
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

Mark options
  --why "<text>"     why you thought so. This is the part worth writing down:
                     the score is the model's opinion, this is yours.

Notify options     (reads config/notify.yaml; see examples/notify.example.yaml)
  --min <n>          override min_score from the config
  --dry-run          print the requests, send nothing, record nothing
  --baseline         record every current lead as sent without sending, so
                     switching notify on over an old database does not flood
                     the sink with postings you have already seen

The id is the short hash \`report\` prints. Any unambiguous prefix works.

Scoring is the only stage that costs money, and it needs ANTHROPIC_API_KEY in
the environment or in a .env file. Everything else runs for nothing.
`;

const KNOWN = new Set(['init', 'setup', 'run', 'discover', 'report', 'mark', 'stats', 'notify']);

const FLAGS = new Set(['dry-run', 'no-score', 'rescore-unscored', 'ai-forward', 'all', 'json', 'force', 'baseline']);
const VALUED = new Set(['limit', 'min', 'db', 'url', 'config', 'why']);

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
  let caps = null;
  if (scoring) {
    rubric = loadRubric(configPath('rubric.md', configDir));
    caps = normalizeCaps(gates.score_caps);
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

  // Postings that passed the gate on an earlier run and were never scored,
  // because that run lost its key or its credit balance partway through. They
  // are already on file, so splitNew will never offer them again; without this
  // they stay unscored forever.
  const stranded = (opts['rescore-unscored'] && !dryRun) ? unscoredPassed(db) : [];
  if (stranded.length) {
    io.err(`recovering ${plural(stranded.length, 'unscored posting')} from earlier runs\n`);
  }
  const toScore = [...stranded, ...passed];

  let scored = [];
  let usage = null;
  let aborted = null;
  if (scoring && toScore.length) {
    io.err(`scoring ${plural(toScore.length, 'posting')}\n`);
    const result = await scoreAll(toScore, {
      rubric,
      client,
      caps,
      onProgress: ({ done, total, usage: u }) => {
        if (done % 25 === 0 || done === total) {
          io.err(`  ${done}/${total}  ~$${u.costUsd.toFixed(3)}\n`);
        }
      },
      onError: (err) => io.err(`  skipped: ${err.message}\n`),
    });
    scored = result.scores;
    usage = result.usage;
    aborted = result.aborted;
    // Write what did land before reporting the abort. A run that scored 300 of
    // 800 before the balance went should keep the 300.
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

  // Scoring stopped on a condition that would have failed for every remaining
  // posting. Say so, and say what it costs, because the funnel line above just
  // reports a small number and looks like a quiet run.
  if (aborted) {
    io.out(`\nSCORING STOPPED: ${aborted.message}\n`);
    io.out('Anything already scored was saved.\n');
  }

  // The standing count, whatever caused it. This is the line whose absence let
  // 244 postings sit unscored and unnoticed after a run that lost its balance.
  if (!dryRun) {
    const pending = unscoredPassedCount(db);
    if (pending) {
      io.out(`\n${plural(pending, 'posting')} passed the gate but ${pending === 1 ? 'is' : 'are'} unscored.\n`);
      io.out('They will not come back as new. Recover them with:\n');
      io.out('  deepjobs run --rescore-unscored\n');
    }
  }

  const top = scored.filter((s) => s.overall >= 60).sort((a, b) => b.overall - a.overall);
  if (top.length) {
    const byHash = new Map(toScore.map((p) => [p.hash, p]));
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
// mark

export const VERDICTS = new Set(['yes', 'no', 'maybe']);

/**
 * The one thing in this database the pipeline cannot produce.
 *
 * `recordPostings` never touches the application table, so a crawl can never
 * overwrite what a person decided about a posting. That was deliberate from
 * the schema onward - and it left the column with no way in at all, which made
 * the feedback loop the schema promises unreachable. This is the door.
 *
 * It is also the input to the only worthwhile next feature: tuning a rubric
 * against postings a human has already judged. Nothing can calibrate against
 * zero examples.
 */
function cmdMark(opts, positional, io) {
  const [prefix, verdict] = positional;
  if (!prefix || !verdict) throw new ConfigError('usage: deepjobs mark <id> yes|no|maybe [--why "..."]');
  if (!VERDICTS.has(verdict.toLowerCase())) {
    throw new ConfigError(`verdict must be one of ${[...VERDICTS].join(', ')}, got "${verdict}"`);
  }

  const db = openDb(opts.db ?? 'data/seen.db');
  const { posting, error } = findByHashPrefix(db, prefix);
  if (error) throw new ConfigError(error);

  setVerdict(db, posting.hash, verdict.toLowerCase(), opts.why ?? null);
  // Echo the posting back. A verdict recorded against the wrong row is worse
  // than no verdict, and the only way to catch that is to show what was hit.
  io.out(`${verdict.toLowerCase()}  ${posting.company} - ${posting.title}\n`);
  if (opts.why) io.out(`      ${opts.why}\n`);
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
    // Your own verdict sits next to the score, because the two disagreeing is
    // the interesting case and the only one worth acting on.
    const mine = row.myVerdict ? `  [you: ${row.myVerdict}]` : '';
    io.out(`${String(row.overall).padStart(3)}  ${row.band.padEnd(8)}  ${row.company} - ${row.title}${mine}\n`);
    io.out(`     ${row.location || '(location not stated)'}${row.aiForward ? '  [ai-forward]' : ''}\n`);
    if (row.rationale) io.out(`     ${row.rationale}\n`);
    if (row.myWhy) io.out(`     you: ${row.myWhy}\n`);
    io.out(`     ${row.url}\n`);
    // The id goes last. It is only there to be typed back into `mark`.
    io.out(`     ${row.shortHash}\n\n`);
  }
  if (limit && rows.length > shown.length) {
    io.out(`${rows.length - shown.length} more above --min. Raise --limit to see them.\n`);
  }
  return 0;
}

// --------------------------------------------------------------------------
// notify

async function cmdNotify(opts, io, deps = {}) {
  loadEnv(deps.envFile ?? '.env');
  const config = normalizeNotify(loadNotify(configPath('notify.yaml', opts.config ?? 'config')));
  const minScore = integer(opts.min, 'min') ?? config.minScore;
  const db = openDb(opts.db ?? 'data/seen.db');
  const leads = pendingLeads(db, { minScore });

  if (!leads.length) {
    io.err(`no new leads at or above ${minScore}\n`);
    return 0;
  }

  if (opts.baseline) {
    for (const lead of leads) recordNotified(db, lead.hash, 'baseline');
    io.out(`recorded ${plural(leads.length, 'lead')} as already seen; the next notify sends only what is new\n`);
    return 0;
  }

  const batch = leads.slice(0, config.maxPerRun);
  const held = leads.length - batch.length;

  if (opts['dry-run']) {
    for (const lead of batch) {
      const req = buildRequest(lead, config);
      // Header values are left out: they are where the tokens live, and a dry
      // run gets pasted into issues and chat.
      io.out(`${req.method} ${req.url}\n  headers: ${Object.keys(req.headers).join(', ') || '(none)'}\n`);
      if (req.body) io.out(`  ${req.body}\n`);
      io.out('\n');
    }
    io.err(`dry run: ${plural(batch.length, 'lead')} would be sent${held ? `, ${held} held for the next run` : ''}\n`);
    return 0;
  }

  const { sent, error } = await sendLeads(batch, config, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    onSent: (lead) => {
      recordNotified(db, lead.hash, 'webhook');
      io.out(`sent  ${String(lead.overall).padStart(3)}  ${lead.company} - ${lead.title}\n`);
    },
  });
  if (error) {
    io.err(`deepjobs: notify stopped after ${plural(sent, 'lead')}: ${error}\n`);
    io.err('nothing after that was recorded, so the next run retries it\n');
    return 1;
  }
  if (held) io.err(`${held} more held for the next run (max_per_run is ${config.maxPerRun})\n`);
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
      case 'mark': return cmdMark(opts, positional, io);
      case 'stats': return cmdStats(opts, io);
      case 'notify': return await cmdNotify(opts, io, deps);
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
