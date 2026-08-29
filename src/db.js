// The seen-store. Decides what is new on any given morning, and holds
// everything the pipeline learns about a posting afterwards.
//
// node:sqlite, built into Node since 22.5, so there is no native module to
// compile and no install step that can fail on a fresh machine.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso } from './lib/posting.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS posting (
  hash            TEXT PRIMARY KEY,   -- sha256(normCompany|normTitle|normLocation)
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  source          TEXT,               -- "greenhouse:stripe"
  company         TEXT,
  title           TEXT,
  location        TEXT,
  url             TEXT,
  description     TEXT,
  remote          INTEGER,            -- 1 / 0 / NULL, and NULL is a real answer
  salary_min      INTEGER,
  salary_max      INTEGER,
  salary_raw      TEXT,
  employment_type TEXT,
  posted_at       TEXT,
  tags            TEXT,               -- JSON array, from signals/ai-forward.yaml
  ai_forward      INTEGER,
  written_at      TEXT
);

CREATE TABLE IF NOT EXISTS board (
  platform    TEXT NOT NULL,
  slug        TEXT NOT NULL,
  name        TEXT,
  parent      TEXT,      -- the acquirer, when a company posts under one
  careers_url TEXT,
  last_ok     TEXT,
  last_error  TEXT,
  last_count  INTEGER,
  PRIMARY KEY (platform, slug)
);

CREATE TABLE IF NOT EXISTS gate_result (
  hash     TEXT PRIMARY KEY REFERENCES posting(hash) ON DELETE CASCADE,
  result   TEXT,          -- pass | reject
  reason   TEXT,
  flags    TEXT,          -- JSON array: HYBRID, CONTRACT, STAFFING, LOW_COMP
  gated_at TEXT
);

CREATE TABLE IF NOT EXISTS score (
  hash               TEXT PRIMARY KEY REFERENCES posting(hash) ON DELETE CASCADE,
  scored_at          TEXT,
  model              TEXT,
  overall            INTEGER,
  -- The six rubric dimensions and their maximums. These are the rubric's own
  -- weights, not a generic tech/experience/behavioral split.
  location_viability INTEGER,   -- 25
  capability_overlap INTEGER,   -- 25
  domain_leverage    INTEGER,   -- 15
  build_latitude     INTEGER,   -- 15
  seniority_fit      INTEGER,   -- 10
  signal_quality     INTEGER,   -- 10
  rationale          TEXT,
  flags              TEXT,      -- JSON array
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cost_usd           REAL
);

CREATE TABLE IF NOT EXISTS application (
  hash       TEXT PRIMARY KEY REFERENCES posting(hash) ON DELETE CASCADE,
  status     TEXT,        -- new | shortlisted | applied | interview | rejected | closed
  applied_at TEXT,
  cv_path    TEXT,
  cover_path TEXT,
  my_verdict TEXT,        -- the human feedback loop
  my_why     TEXT
);

CREATE INDEX IF NOT EXISTS idx_posting_written ON posting(written_at);
CREATE INDEX IF NOT EXISTS idx_posting_forward ON posting(ai_forward);
CREATE INDEX IF NOT EXISTS idx_score_overall   ON score(overall);
CREATE INDEX IF NOT EXISTS idx_gate_result     ON gate_result(result);
`;

/** Open (and create) the database. Pass ':memory:' in tests. */
export function openDb(path = 'data/seen.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

// SQLite has no boolean. A tri-state has to survive the round trip intact,
// because "the board did not say" and "the board said no" lead to different
// gate decisions.
function toInt(value) {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function fromInt(value) {
  if (value === null || value === undefined) return null;
  return value === 1;
}

function toJson(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return JSON.stringify(value);
}

function fromJson(value) {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

// --------------------------------------------------------------------------
// postings
// --------------------------------------------------------------------------

export function knownHashes(db) {
  return new Set(db.prepare('SELECT hash FROM posting').all().map((r) => r.hash));
}

/**
 * Return only postings never seen before, deduped within the batch as well.
 *
 * Two boards carrying the same job on the same morning is the common case,
 * not the edge case, so the in-batch check matters as much as the lookup.
 */
export function splitNew(db, postings) {
  const known = knownHashes(db);
  const batch = new Set();
  const fresh = [];
  for (const p of postings) {
    if (known.has(p.hash) || batch.has(p.hash)) continue;
    batch.add(p.hash);
    fresh.push(p);
  }
  return fresh;
}

const INSERT_POSTING = `
INSERT INTO posting (hash, first_seen, last_seen, source, company, title,
                     location, url, description, remote, salary_min,
                     salary_max, salary_raw, employment_type, posted_at,
                     tags, ai_forward)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(hash) DO UPDATE SET
  last_seen       = excluded.last_seen,
  source          = COALESCE(excluded.source,          posting.source),
  url             = COALESCE(excluded.url,             posting.url),
  description     = COALESCE(excluded.description,     posting.description),
  remote          = COALESCE(excluded.remote,          posting.remote),
  salary_min      = COALESCE(excluded.salary_min,      posting.salary_min),
  salary_max      = COALESCE(excluded.salary_max,      posting.salary_max),
  salary_raw      = COALESCE(excluded.salary_raw,      posting.salary_raw),
  employment_type = COALESCE(excluded.employment_type, posting.employment_type),
  posted_at       = COALESCE(excluded.posted_at,       posting.posted_at),
  tags            = COALESCE(excluded.tags,            posting.tags),
  ai_forward      = COALESCE(excluded.ai_forward,      posting.ai_forward)
`;

/**
 * Insert postings, or refresh them if already on file.
 *
 * INSERT ... ON CONFLICT with COALESCE on every column, never INSERT OR
 * REPLACE. A list endpoint returns no description where a detail call did, so
 * a re-run that wrote plain `excluded.description` would blank out a body that
 * had already been fetched and paid for. The rule is that a re-run may add
 * information and may never remove it.
 */
export function recordPostings(db, postings) {
  const list = [...postings];
  if (list.length === 0) return 0;
  const now = nowIso();
  const stmt = db.prepare(INSERT_POSTING);
  const run = db.prepare('BEGIN');
  run.run();
  try {
    for (const p of list) {
      stmt.run(
        p.hash,
        p.firstSeen ?? now,
        now,
        p.source || null,
        p.company || null,
        p.title || null,
        p.location || null,
        p.url || null,
        p.description || null,
        toInt(p.remote),
        p.salaryMin ?? null,
        p.salaryMax ?? null,
        p.salaryRaw ?? null,
        p.employmentType ?? null,
        p.postedAt ?? null,
        toJson(p.tags),
        toInt(p.aiForward),
      );
    }
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
  return list.length;
}

/** Bump last_seen for postings already on file. Keeps a stale-role signal. */
export function touchSeen(db, postings) {
  const now = nowIso();
  const stmt = db.prepare('UPDATE posting SET last_seen = ? WHERE hash = ?');
  let n = 0;
  for (const p of postings) n += stmt.run(now, p.hash).changes;
  return n;
}

export function getPosting(db, hash) {
  const row = db.prepare('SELECT * FROM posting WHERE hash = ?').get(hash);
  return row ? rowToPosting(row) : null;
}

/**
 * Postings that passed the gate and were never scored.
 *
 * These exist because the pipeline records the gate result before it spends
 * any money, which is the right order — a run that dies during scoring still
 * keeps everything it learned for free. The cost is that the posting is now on
 * file, so `splitNew` will not offer it again on the next run and it would sit
 * there unscored forever. This query is how it gets found and finished.
 */
export function unscoredPassed(db, { limit = null } = {}) {
  const rows = db.prepare(`
    SELECT p.*, g.flags AS gate_flags
    FROM posting p
    JOIN gate_result g ON g.hash = p.hash
    LEFT JOIN score s  ON s.hash = p.hash
    WHERE g.result = 'pass' AND s.hash IS NULL
    ORDER BY p.first_seen DESC
    ${limit ? 'LIMIT ?' : ''}
  `).all(...(limit ? [limit] : []));

  return rows.map((row) => ({
    ...rowToPosting(row),
    // The gate's flags travel with the posting: the scorer is given them, and
    // recordScore merges them back in. A recovered posting that lost its
    // HYBRID flag would score as though the gate had never run.
    flags: fromJson(row.gate_flags),
  }));
}

/** How many gate-passed postings are still unscored. Cheap enough to call on every run. */
export function unscoredPassedCount(db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM gate_result g
    LEFT JOIN score s ON s.hash = g.hash
    WHERE g.result = 'pass' AND s.hash IS NULL
  `).get();
  return row?.n ?? 0;
}

function rowToPosting(row) {
  return {
    hash: row.hash,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    source: row.source ?? '',
    company: row.company ?? '',
    title: row.title ?? '',
    location: row.location ?? '',
    url: row.url ?? '',
    description: row.description ?? '',
    remote: fromInt(row.remote),
    salaryMin: row.salary_min ?? null,
    salaryMax: row.salary_max ?? null,
    salaryRaw: row.salary_raw ?? null,
    employmentType: row.employment_type ?? null,
    postedAt: row.posted_at ?? null,
    tags: fromJson(row.tags),
    aiForward: fromInt(row.ai_forward),
    writtenAt: row.written_at ?? null,
  };
}

/**
 * Flag postings as reported. Only ever touches rows where written_at is null,
 * which is what makes a re-run idempotent instead of re-reporting yesterday.
 */
export function markWritten(db, hashes) {
  const now = nowIso();
  const stmt = db.prepare(
    'UPDATE posting SET written_at = ? WHERE hash = ? AND written_at IS NULL',
  );
  let n = 0;
  for (const hash of hashes) n += stmt.run(now, hash).changes;
  return n;
}

// --------------------------------------------------------------------------
// gate, score, application
// --------------------------------------------------------------------------

export function recordGate(db, hash, { result, reason = null, flags = [] }) {
  db.prepare(`
    INSERT INTO gate_result (hash, result, reason, flags, gated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(hash) DO UPDATE SET
      result = excluded.result,
      reason = excluded.reason,
      flags  = excluded.flags,
      gated_at = excluded.gated_at
  `).run(hash, result, reason, toJson(flags), nowIso());
}

export function recordScore(db, hash, score) {
  db.prepare(`
    INSERT INTO score (hash, scored_at, model, overall, location_viability,
                       capability_overlap, domain_leverage, build_latitude,
                       seniority_fit, signal_quality, rationale, flags,
                       input_tokens, output_tokens, cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(hash) DO UPDATE SET
      scored_at          = excluded.scored_at,
      model              = excluded.model,
      overall            = excluded.overall,
      location_viability = excluded.location_viability,
      capability_overlap = excluded.capability_overlap,
      domain_leverage    = excluded.domain_leverage,
      build_latitude     = excluded.build_latitude,
      seniority_fit      = excluded.seniority_fit,
      signal_quality     = excluded.signal_quality,
      rationale          = excluded.rationale,
      flags              = excluded.flags,
      input_tokens       = excluded.input_tokens,
      output_tokens      = excluded.output_tokens,
      cost_usd           = excluded.cost_usd
  `).run(
    hash,
    score.scoredAt ?? nowIso(),
    score.model ?? null,
    score.overall ?? null,
    score.locationViability ?? null,
    score.capabilityOverlap ?? null,
    score.domainLeverage ?? null,
    score.buildLatitude ?? null,
    score.seniorityFit ?? null,
    score.signalQuality ?? null,
    score.rationale ?? null,
    toJson(score.flags),
    score.inputTokens ?? null,
    score.outputTokens ?? null,
    score.costUsd ?? null,
  );
}

/**
 * The human feedback loop, and the only thing in the system that produces
 * training signal. It lives in its own table so that no amount of re-running
 * the pipeline can reach it.
 */
export function setVerdict(db, hash, verdict, why = null) {
  db.prepare(`
    INSERT INTO application (hash, status, my_verdict, my_why)
    VALUES (?, 'new', ?, ?)
    ON CONFLICT(hash) DO UPDATE SET
      my_verdict = excluded.my_verdict,
      my_why     = excluded.my_why
  `).run(hash, verdict, why);
}

/**
 * Resolve the short hash a report prints back to a posting.
 *
 * Nobody types 64 hex characters, so the report shows the first eight and this
 * accepts any prefix. An ambiguous prefix is an error rather than a first
 * match: silently marking the wrong posting is worse than asking again, and
 * the human verdict is the one field in this database nothing else can
 * reconstruct.
 */
export function findByHashPrefix(db, prefix) {
  const clean = String(prefix ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{4,64}$/.test(clean)) return { error: `"${prefix}" is not a hash. Run \`deepjobs report\` for the short ids.` };
  const rows = db.prepare('SELECT * FROM posting WHERE hash LIKE ? ORDER BY hash LIMIT 5').all(`${clean}%`);
  if (!rows.length) return { error: `no posting starts with "${clean}"` };
  if (rows.length > 1) {
    const shown = rows.map((r) => `  ${r.hash.slice(0, 12)}  ${r.company} - ${r.title}`).join('\n');
    return { error: `"${clean}" matches ${rows.length} postings. Use more characters:\n${shown}` };
  }
  return { posting: rowToPosting(rows[0]) };
}

export function getVerdict(db, hash) {
  const row = db.prepare('SELECT my_verdict, my_why FROM application WHERE hash = ?').get(hash);
  return row ? { verdict: row.my_verdict, why: row.my_why } : null;
}

// --------------------------------------------------------------------------
// boards
// --------------------------------------------------------------------------

export function upsertBoard(db, board) {
  db.prepare(`
    INSERT INTO board (platform, slug, name, parent, careers_url, last_ok,
                       last_error, last_count)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(platform, slug) DO UPDATE SET
      name        = COALESCE(excluded.name,        board.name),
      parent      = COALESCE(excluded.parent,      board.parent),
      careers_url = COALESCE(excluded.careers_url, board.careers_url),
      last_ok     = COALESCE(excluded.last_ok,     board.last_ok),
      last_error  = excluded.last_error,
      last_count  = COALESCE(excluded.last_count,  board.last_count)
  `).run(
    board.platform,
    board.slug,
    board.name ?? null,
    board.parent ?? null,
    board.careersUrl ?? null,
    board.lastOk ?? null,
    board.lastError ?? null,
    board.lastCount ?? null,
  );
}

export function boards(db) {
  return db.prepare('SELECT * FROM board ORDER BY platform, slug').all();
}

// --------------------------------------------------------------------------
// reporting
// --------------------------------------------------------------------------

/** Scoring bands. A number without a band is hard to act on. */
export function scoreBand(overall) {
  if (overall === null || overall === undefined) return null;
  if (overall >= 75) return 'Strong';
  if (overall >= 60) return 'Good';
  if (overall >= 45) return 'Moderate';
  if (overall >= 30) return 'Weak';
  return 'Poor';
}

export function report(db, { minScore = 0, aiForwardOnly = false, unwrittenOnly = false } = {}) {
  const where = ['s.overall >= ?'];
  const params = [minScore];
  if (aiForwardOnly) where.push('p.ai_forward = 1');
  if (unwrittenOnly) where.push('p.written_at IS NULL');
  const rows = db.prepare(`
    SELECT p.*, s.overall, s.rationale, s.flags AS score_flags,
           s.location_viability, s.capability_overlap, s.domain_leverage,
           s.build_latitude, s.seniority_fit, s.signal_quality,
           g.result AS gate_result, a.my_verdict, a.my_why
    FROM posting p
    JOIN score s ON s.hash = p.hash
    LEFT JOIN gate_result g ON g.hash = p.hash
    LEFT JOIN application a ON a.hash = p.hash
    WHERE ${where.join(' AND ')}
    ORDER BY s.overall DESC
  `).all(...params);
  return rows.map((row) => ({
    ...rowToPosting(row),
    overall: row.overall,
    band: scoreBand(row.overall),
    // The six dimensions come back with the row. A total on its own says a
    // posting is a 42; the parts say which of the six is what cost it, which
    // is the only version of the number anyone can act on.
    dimensions: {
      locationViability: row.location_viability,
      capabilityOverlap: row.capability_overlap,
      domainLeverage: row.domain_leverage,
      buildLatitude: row.build_latitude,
      seniorityFit: row.seniority_fit,
      signalQuality: row.signal_quality,
    },
    rationale: row.rationale,
    scoreFlags: fromJson(row.score_flags),
    gateResult: row.gate_result,
    myVerdict: row.my_verdict,
    myWhy: row.my_why,
    // What a person types to mark this one. Eight characters is unambiguous
    // across corpora far larger than anything a job search produces.
    shortHash: row.hash.slice(0, 8),
  }));
}

export function stats(db) {
  const row = db.prepare(`
    SELECT (SELECT COUNT(*) FROM posting)                                AS total,
           (SELECT COUNT(*) FROM posting WHERE ai_forward = 1)           AS ai_forward,
           (SELECT COUNT(*) FROM gate_result WHERE result = 'pass')      AS gate_passed,
           (SELECT COUNT(*) FROM score)                                  AS scored,
           (SELECT COUNT(*) FROM posting WHERE written_at IS NOT NULL)   AS written,
           (SELECT COUNT(*) FROM application WHERE my_verdict IS NOT NULL) AS with_verdict,
           (SELECT COALESCE(SUM(cost_usd), 0) FROM score)                AS cost_usd
  `).get();
  return row;
}
