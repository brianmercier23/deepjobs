// Stage two, and the only stage that costs money.
//
// The rubric is the product. This module is deliberately thin: it formats a
// posting, sends it with the rubric as the system prompt, and parses JSON back.
// When scores feel wrong the fix is almost always in `config/rubric.md`, not
// here. Resist the urge to add judgment to this file — every rule that lands
// in code instead of the rubric is a rule the user cannot change.
//
// Cost control lives in two places: the gate that runs before this, and
// MAX_DESCRIPTION_CHARS below. Descriptions are the overwhelming majority of
// the input tokens, and the last few thousand characters of a job ad are
// equal-opportunity boilerplate and dental plans.

import { readFileSync } from 'node:fs';

export const MODEL = 'claude-haiku-4-5';

// Measured: 4,500 chars covers the summary, the responsibilities and most of
// the requirements. What gets cut is the EEO statement and the benefits list.
export const MAX_DESCRIPTION_CHARS = 4500;

// Six sub-scores, a total, a sentence and a few flags. 400 is roughly double
// what a well-behaved response needs, which is the margin that keeps a slightly
// chatty one from being truncated into unparseable JSON.
export const MAX_TOKENS = 400;

export const RETRIES = 2;
export const RETRY_BACKOFF_MS = 1_500;

// Pinned, not left to the default. See scoreOne.
export const TEMPERATURE = 0;

// Trimmed in code rather than by prompt. See cleanRationale.
export const MAX_RATIONALE_WORDS = 30;

// How far the stated total may exceed the six sub-scores before it is worth
// telling someone. Five points is inside rounding; twenty is a different verdict.
export const SUBSCORE_TOLERANCE = 5;
export const FLAG_SUBSCORE_MISMATCH = 'subscore_mismatch';

// Haiku 4.5 list pricing, USD per million tokens. Used only for the run-cost
// line, so a stale number here misreports spend but breaks nothing.
export const PRICING = {
  input: 1.0,
  output: 5.0,
  cacheWrite: 1.25, // 1.25x input
  cacheRead: 0.1, //  0.1x input
};

/**
 * The six dimensions, their weights, and where each lands in the database.
 *
 * These are the rubric's own weights rather than a generic
 * technical/experience/behavioral split, because a generic split scores every
 * candidate the same way and the entire point is that it should not.
 */
export const DIMENSIONS = [
  { key: 'location', field: 'locationViability', max: 25, label: 'Location viability' },
  { key: 'capability', field: 'capabilityOverlap', max: 25, label: 'Capability overlap' },
  { key: 'domain', field: 'domainLeverage', max: 15, label: 'Domain leverage' },
  { key: 'build', field: 'buildLatitude', max: 15, label: 'Build latitude' },
  { key: 'seniority', field: 'seniorityFit', max: 10, label: 'Seniority fit' },
  { key: 'signal', field: 'signalQuality', max: 10, label: 'Signal quality' },
];

export class ScoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScoreError';
  }
}

/**
 * The output contract, appended to whatever rubric the user wrote.
 *
 * A user's rubric describes what they want out of a career. Asking them to
 * also specify a JSON envelope invites a typo that breaks every call, so the
 * envelope lives here and the rubric stays about the job. A rubric that never
 * mentions the six dimensions still works: the sub-scores come back missing,
 * the parser records nulls, and the overall is all anyone needed anyway.
 */
export const OUTPUT_CONTRACT = `

---

# Output format

Return only JSON. No preamble, no explanation, no code fence.

{"score": <int 0-100>, "dimensions": {${DIMENSIONS.map((d) => `"${d.key}": <int 0-${d.max}>`).join(', ')}}, "rationale": "<one short sentence naming the deciding factor>", "flags": ["<short tag>", ...]}

The six dimensions are ${DIMENSIONS.map((d) => `${d.label} (0-${d.max})`).join(', ')}.

Score each dimension on the role as described. "score" is the rubric's verdict
on the whole posting: normally the sum of the six, but lower where the rubric
states a cap, an automatic low score, or a disqualifying condition. Never
higher than the six dimensions support.

Rationale: one sentence, under 25 words, naming the single deciding factor. Not
a summary of everything you considered. When the score is low, lead with what
killed it. "Good operations role" is useless; "remote, but the body requires
three days a week onsite" is useful.

Flags are notes for a human to look at, not reasons to reject.`;

/** Read a rubric off disk, refusing one that is obviously not finished. */
export function loadRubric(path = 'config/rubric.md') {
  let text;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new ScoreError(
      `rubric not found: ${path}. Run \`deepjobs init\` for the example one, or \`deepjobs setup\` to write your own.`,
    );
  }
  if (text.length < 500) {
    throw new ScoreError(`rubric at ${path} looks truncated (${text.length} chars)`);
  }
  return text;
}

/** Rubric plus envelope. Split out so a test can check the halves separately. */
export function systemPrompt(rubric) {
  return `${rubric.trim()}${OUTPUT_CONTRACT}`;
}

/**
 * Render a posting for the model. The deciding fields go first.
 *
 * Truncation cuts at the last newline inside the budget rather than mid-word,
 * and says so, because a description that stops in the middle of a sentence
 * reads to the model like a thin posting and quietly costs signal-quality
 * points the employer did not earn.
 */
export function formatPosting(posting, { flags = [] } = {}) {
  let desc = String(posting.description ?? '').trim();
  if (desc.length > MAX_DESCRIPTION_CHARS) {
    const cut = desc.slice(0, MAX_DESCRIPTION_CHARS);
    const lastBreak = cut.lastIndexOf('\n');
    desc = `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}\n[description truncated]`;
  }

  const lines = [
    `Company: ${posting.company}`,
    `Title: ${posting.title}`,
    `Location: ${posting.location || '(not stated)'}`,
  ];
  if (posting.remote !== null && posting.remote !== undefined) {
    lines.push(`Board says remote: ${posting.remote}`);
  }
  if (posting.employmentType) lines.push(`Employment type: ${posting.employmentType}`);

  const salary = salaryLine(posting);
  lines.push(`Compensation: ${salary || '(not disclosed)'}`);
  if (posting.postedAt) lines.push(`Posted: ${posting.postedAt}`);

  const allFlags = [...new Set([...(posting.flags ?? []), ...flags])];
  if (allFlags.length) lines.push(`Gate flags: ${allFlags.join(', ')}`);

  lines.push('', 'Description:', desc || '(no description provided)');
  return lines.join('\n');
}

function salaryLine(posting) {
  const fmt = (n) => `$${Number(n).toLocaleString('en-US')}`;
  const { salaryMin: lo, salaryMax: hi } = posting;
  if (lo && hi && lo !== hi) return `${fmt(lo)} - ${fmt(hi)}`;
  if (hi) return fmt(hi);
  if (lo) return fmt(lo);
  return posting.salaryRaw ? String(posting.salaryRaw).trim() : '';
}

/**
 * Enforce the one-short-sentence contract the model keeps stretching.
 *
 * This is done in code and not by prompt because the prompt asks for 25 words
 * and reliably gets 40. The rationale is scanned in about a second in a report
 * row; a run-on with three clauses is not read at all, so trimming it loses
 * nothing. Em dashes and semicolons go first because they are exactly the
 * joints a second clause hangs off.
 */
export function cleanRationale(text) {
  let s = String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
  if (!s) return '';

  s = s.replace(/—/g, ', ').replace(/–/g, '-').replace(/;/g, ',');
  s = s.replace(/\s*,\s*,+/g, ', ');
  s = s.replace(/\s+([,.])/g, '$1');
  // Substituting ", " for a spaced em dash leaves a double space behind. The
  // Python this ports from has the same seam and leaves it in.
  s = s.replace(/\s+/g, ' ').trim();

  const words = s.split(' ');
  if (words.length > MAX_RATIONALE_WORDS) {
    const head = words.slice(0, MAX_RATIONALE_WORDS).join(' ');
    // Prefer cutting at a clause boundary, but only if one exists far enough in
    // that the result is still a sentence rather than a fragment.
    const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('. '));
    s = cut > 40 ? head.slice(0, cut) : head;
    s = s.replace(/[\s,.]+$/, '');
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const JSON_RE = /\{[\s\S]*\}/;

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Pull the verdict out of a response, tolerating stray prose.
 *
 * Two fallbacks, both earned: models fence JSON they were told not to fence,
 * and they preface it with a sentence they were told not to write. Neither is
 * worth a retry when the JSON itself is sitting right there.
 */
export function parseVerdict(text) {
  let raw = String(text ?? '').trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const match = JSON_RE.exec(raw);
    if (!match) throw new ScoreError(`no JSON in response: ${JSON.stringify(raw.slice(0, 200))}`);
    try {
      data = JSON.parse(match[0]);
    } catch (err) {
      throw new ScoreError(`unparseable JSON in response: ${err.message}`);
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data) || !('score' in data)) {
    throw new ScoreError(`response missing "score": ${JSON.stringify(raw.slice(0, 200))}`);
  }

  const overall = toInt(data.score);
  if (overall === null) throw new ScoreError(`non-numeric score: ${JSON.stringify(data.score)}`);

  const dims = data.dimensions && typeof data.dimensions === 'object' ? data.dimensions : {};
  const verdict = { overall: Math.max(0, Math.min(100, overall)) };

  let subtotal = 0;
  let complete = true;
  for (const d of DIMENSIONS) {
    const given = toInt(dims[d.key]);
    if (given === null) {
      verdict[d.field] = null;
      complete = false;
      continue;
    }
    const clamped = Math.max(0, Math.min(d.max, given));
    verdict[d.field] = clamped;
    subtotal += clamped;
  }

  let flags = data.flags ?? [];
  if (typeof flags === 'string') flags = [flags];
  if (!Array.isArray(flags)) flags = [];
  flags = flags.map((f) => String(f).trim()).filter(Boolean);

  // The six parts and the total are answering two different questions, and the
  // gap between them is the useful part. The dimensions read the role; the
  // total is the rubric's verdict on it, which a cap or an automatic-low-score
  // rule can push well below the sum. Measured on a rubric with such rules, 22
  // of 28 postings scored below their own subtotal, some by 40 points, and the
  // size of that gap is what tells a user which rule fired.
  //
  // So the check is one-sided. Every override a rubric can state pushes the
  // number down; nothing justifies a total the dimensions do not support, and
  // that is the only direction worth flagging. The total stays authoritative
  // either way — silently rewriting one of two numbers the model gave you is
  // how a scorer becomes impossible to debug six months later.
  if (complete) {
    verdict.subtotal = subtotal;
    if (verdict.overall - subtotal > SUBSCORE_TOLERANCE) flags.push(FLAG_SUBSCORE_MISMATCH);
  }

  verdict.rationale = cleanRationale(data.rationale);
  verdict.flags = flags;
  return verdict;
}


/** What one call cost, in the shape `db.recordScore` stores. */
export function callCost(usage = {}) {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    inputTokens: inputTokens + cacheWrite + cacheRead,
    outputTokens,
    costUsd: (inputTokens * PRICING.input
      + outputTokens * PRICING.output
      + cacheWrite * PRICING.cacheWrite
      + cacheRead * PRICING.cacheRead) / 1_000_000,
  };
}

/** Per-run token and dollar accounting. Nothing here changes what gets sent. */
export class Usage {
  constructor() {
    this.calls = 0;
    this.failures = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheWriteTokens = 0;
    this.cacheReadTokens = 0;
  }

  add(usage = {}) {
    this.calls += 1;
    this.inputTokens += usage.input_tokens ?? 0;
    this.outputTokens += usage.output_tokens ?? 0;
    this.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    this.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  }

  get costUsd() {
    return (
      (this.inputTokens * PRICING.input
        + this.outputTokens * PRICING.output
        + this.cacheWriteTokens * PRICING.cacheWrite
        + this.cacheReadTokens * PRICING.cacheRead) / 1_000_000
    );
  }

  /** What the same run would have cost with the rubric sent uncached. */
  get costWithoutCacheUsd() {
    const inTokens = this.inputTokens + this.cacheWriteTokens + this.cacheReadTokens;
    return (inTokens * PRICING.input + this.outputTokens * PRICING.output) / 1_000_000;
  }

  summary() {
    const n = (v) => v.toLocaleString('en-US');
    const cached = this.cacheReadTokens
      ? `, ${n(this.cacheReadTokens)} cached`
      : '';
    return `${this.calls} scored, ${this.failures} failed, ${n(this.inputTokens)} in${cached} / ${n(this.outputTokens)} out, ~$${this.costUsd.toFixed(3)}`;
  }
}

/**
 * The SDK is imported lazily so that everything free in this package — the
 * collectors, the gate, the tagger, the whole test suite — runs with no API
 * key, no network, and no reason to have installed a client at all.
 */
export async function createClient({ apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!apiKey) {
    throw new ScoreError('ANTHROPIC_API_KEY is not set. Scoring is the only stage that needs it; `deepjobs run --no-score` does everything else for free.');
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Score one posting. Throws ScoreError only after every retry is spent.
 *
 * The rubric goes in the system prompt with a cache breakpoint on it. It is
 * byte-identical on every call in a run, so a long one is read from cache at a
 * tenth of the input price after the first posting.
 *
 * Do not expect that to fire on a normal rubric. Measured on this model: a
 * 3,689-token system prompt does not cache, a 4,910-token one does, so the
 * minimum cacheable prefix is 4,096 tokens and the example rubric plus this
 * contract comes to about 2,100. The breakpoint costs nothing and pays off for
 * the users who write long rubrics; it is not a saving to advertise.
 */
export async function scoreOne(posting, { rubric, client, usage = null, flags = [] } = {}) {
  if (!rubric) throw new ScoreError('scoreOne needs a rubric');
  if (!client) throw new ScoreError('scoreOne needs a client');

  const system = [{ type: 'text', text: systemPrompt(rubric), cache_control: { type: 'ephemeral' } }];
  const prompt = formatPosting(posting, { flags });
  let last = null;

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // A score that changes when nothing about the posting changed is not a
        // score. Measured at the default sampling temperature, rescoring the
        // same 28 postings moved a quarter of them by more than 10 points,
        // which is more than the difference this tool exists to detect.
        temperature: TEMPERATURE,
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      if (usage) usage.add(response.usage);

      const text = (response.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const verdict = parseVerdict(text);
      const spend = callCost(response.usage);
      return {
        hash: posting.hash,
        model: MODEL,
        ...verdict,
        // Keep the deterministic gate flags and append the model's.
        flags: [...new Set([...(posting.flags ?? []), ...flags, ...verdict.flags])],
        // Per-posting, not just per-run. A single line in a report showing what
        // one verdict cost is the thing that stops someone from wondering.
        ...spend,
      };
    } catch (err) {
      last = err;
      if (attempt < RETRIES) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  throw new ScoreError(`failed to score ${posting.company} / ${posting.title}: ${last?.message ?? last}`);
}

/**
 * Score a batch.
 *
 * A posting that will not score is skipped and counted, never fatal: one
 * malformed description should not cost the other eight hundred results. The
 * Python this replaces ran strictly serially; a small worker pool turns a
 * twenty-minute run into a five-minute one, and four is chosen to stay well
 * inside the rate limits of a first-time key rather than to go as fast as
 * possible.
 */
export async function scoreAll(postings, {
  rubric,
  client,
  limit = null,
  concurrency = 4,
  flagsFor = null,
  onProgress = null,
  onError = null,
} = {}) {
  const batch = limit ? postings.slice(0, limit) : [...postings];
  const usage = new Usage();
  const scores = new Array(batch.length).fill(null);

  let next = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= batch.length) return;

      const posting = batch[i];
      try {
        scores[i] = await scoreOne(posting, {
          rubric,
          client,
          usage,
          flags: flagsFor ? flagsFor(posting) : [],
        });
      } catch (err) {
        usage.failures += 1;
        if (onError) onError(err, posting);
      }
      done += 1;
      if (onProgress) onProgress({ done, total: batch.length, usage });
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, batch.length)) },
    () => worker(),
  );
  await Promise.all(workers);

  return { scores: scores.filter(Boolean), usage };
}
