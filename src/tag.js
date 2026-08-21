// Tagging. Free, runs on every posting at ingest, before anything is paid for.
//
// This is the file that decides which postings are worth a second look, using
// nothing but the words already in the description. It is also the part of the
// repo most worth extending: the keyword set is shipped working and tracked,
// unlike the rubric and the board list.

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * Word-boundary matcher for one term.
 *
 * Boundaries matter more here than anywhere else in the pipeline. "rag" as a
 * substring appears in "storage", "fragment" and "dragging"; "mcp" appears in
 * product codes. A substring search would tag half the corpus and the flag
 * would mean nothing.
 */
export function termMatcher(term) {
  const escaped = String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i');
}

/** Flatten the two-level YAML into a flat matcher list. */
export function buildMatchers(signals) {
  const matchers = [];
  for (const side of ['forward', 'legacy']) {
    for (const [category, terms] of Object.entries(signals?.[side] ?? {})) {
      for (const term of terms ?? []) {
        matchers.push({ term, category, side, re: termMatcher(term) });
      }
    }
  }
  return matchers;
}

export function loadSignals(path = 'signals/ai-forward.yaml') {
  return parse(readFileSync(path, 'utf8'));
}

/**
 * Tag one posting.
 *
 * Both the title and the body are searched, because a title naming a tool is
 * a stronger signal than a body mentioning one in passing, and losing it would
 * be perverse.
 */
export function tagText(text, matchers) {
  const forward = [];
  const legacy = [];
  for (const m of matchers) {
    if (!m.re.test(text)) continue;
    (m.side === 'forward' ? forward : legacy).push(m.term);
  }
  return {
    tags: [...forward, ...legacy],
    forward,
    legacy,
    // One forward term is enough. This is a "worth reading" signal, not a
    // score, and the scorer is what decides how much it is worth.
    aiForward: forward.length > 0,
  };
}

export function tagPosting(posting, matchers) {
  return tagText(`${posting.title}\n${posting.description}`, matchers);
}

/** Tag a batch and report what fired, which is how the set gets tuned. */
export function tagAll(postings, signals) {
  const matchers = buildMatchers(signals);
  const counts = new Map();
  let aiForward = 0;
  const tagged = postings.map((posting) => {
    const result = tagPosting(posting, matchers);
    if (result.aiForward) aiForward += 1;
    for (const term of result.tags) counts.set(term, (counts.get(term) ?? 0) + 1);
    return { ...posting, tags: result.tags, aiForward: result.aiForward };
  });
  return { tagged, aiForward, counts };
}
