import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadSignals, buildMatchers, termMatcher, tagText, tagAll } from '../src/tag.js';
import { makePosting } from '../src/lib/posting.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const signals = loadSignals(join(ROOT, 'signals/ai-forward.yaml'));
const matchers = buildMatchers(signals);

test('the shipped signal set loads and has both halves', () => {
  assert.ok(matchers.length > 30);
  assert.ok(matchers.some((m) => m.side === 'forward' && m.term === 'mcp'));
  assert.ok(matchers.some((m) => m.side === 'legacy'));
});

test('terms match on word boundaries, not substrings', () => {
  // The reason this matters more here than anywhere else: "rag" is inside
  // storage, fragment and dragging; "mcp" turns up in product codes. A
  // substring search tags half the corpus and the flag stops meaning anything.
  const rag = termMatcher('rag');
  assert.ok(rag.test('we build RAG pipelines'));
  assert.ok(rag.test('retrieval (RAG) systems'));
  assert.ok(!rag.test('object storage at scale'));
  assert.ok(!rag.test('a fragment of the pipeline'));
  assert.ok(!rag.test('dragging the timeline'));

  const mcp = termMatcher('mcp');
  assert.ok(mcp.test('MCP integrations'));
  assert.ok(!mcp.test('part number MCP-4471'), 'hyphenated product codes are not the protocol');
});

test('multi-word terms tolerate any run of whitespace', () => {
  const t = termMatcher('model context protocol');
  assert.ok(t.test('the Model  Context\nProtocol server'));
});

test('a posting naming the tools is ai-forward', () => {
  const r = tagText('Build with Claude Code, MCP, and agentic workflows every day.', matchers);
  assert.equal(r.aiForward, true);
  assert.ok(r.forward.includes('claude code'));
  assert.ok(r.forward.includes('mcp'));
  assert.ok(r.forward.includes('agentic'));
});

test('a posting naming none of them is not', () => {
  const r = tagText('Maintain the vendor scorecard and produce the weekly deck.', matchers);
  assert.equal(r.aiForward, false);
  assert.deepEqual(r.tags, []);
});

test('"articulate" is a verb before it is a product', () => {
  // Measured: the bare word fired on 245 of 2,897 real postings, essentially
  // all of them "articulate technical tradeoffs to engineers", which is a
  // communication requirement in half the job market. Removing it took legacy
  // hits from 281 to 40. The product names stayed.
  const verb = tagText('You can articulate technical tradeoffs to non-technical partners.', matchers);
  assert.deepEqual(verb.legacy, []);

  const product = tagText('Author courses in Articulate Storyline and manage the LMS.', matchers);
  assert.ok(product.legacy.includes('articulate storyline'));
});

test('the two halves are not exclusive', () => {
  // A posting can name both, and that is informative rather than contradictory:
  // it usually means a legacy team that has started building.
  const r = tagText('Migrate our Cornerstone LMS content and pilot an agentic workflow.', matchers);
  assert.ok(r.forward.length > 0);
  assert.ok(r.legacy.length > 0);
  assert.equal(r.aiForward, true, 'a forward term is enough; this is a "worth reading" signal');
});

test('the title counts, not just the body', () => {
  const r = tagText('AI Agent Engineer\nOwn the roadmap and the hiring plan.', matchers);
  assert.equal(r.aiForward, true);
});

test('tagAll reports what fired, which is how the set gets tuned', () => {
  const postings = [
    makePosting({ company: 'A', title: 'Automation Engineer', description: 'We use MCP and RAG.' }),
    makePosting({ company: 'B', title: 'LMS Administrator', description: 'ADDIE and Cornerstone.' }),
    makePosting({ company: 'C', title: 'Analyst', description: 'Weekly reporting.' }),
  ];
  const { tagged, aiForward, counts } = tagAll(postings, signals);
  assert.equal(aiForward, 1);
  assert.equal(tagged[0].aiForward, true);
  assert.equal(tagged[1].aiForward, false);
  assert.deepEqual(tagged[2].tags, []);
  assert.equal(counts.get('mcp'), 1);
  assert.equal(counts.get('addie'), 1);
});
