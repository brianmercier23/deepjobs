import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Returns true when git would ignore the path. Tests the real rule rather
// than a substring of .gitignore, which is the whole point: the split has to
// hold structurally, not by anyone remembering it.
function isIgnored(relPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', relPath], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

test('package is ESM on a runtime that has node:sqlite', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=22.5');
});

test('runtime dependencies stay at two', () => {
  // The README claims this. If a third dependency is ever worth adding, this
  // test is the place the claim gets renegotiated rather than quietly broken.
  const deps = Object.keys(pkg.dependencies);
  assert.deepEqual(deps.sort(), ['@anthropic-ai/sdk', 'yaml']);
});

test('the bin entry exists and is the declared command', () => {
  assert.deepEqual(Object.keys(pkg.bin), ['deepjobs']);
  assert.ok(existsSync(join(ROOT, pkg.bin.deepjobs)));
});

test('personal config is ignored', () => {
  for (const p of [
    'config/rubric.md',
    'config/companies.yaml',
    'config/gates.yaml',
    'data/seen.db',
    '.env',
    '.env.local',
  ]) {
    assert.ok(isIgnored(p), `${p} must be gitignored`);
  }
});

test('the shipped inputs are tracked', () => {
  for (const p of [
    'signals/ai-forward.yaml',
    'examples/rubric.example.md',
    'examples/companies.example.yaml',
    'examples/gates.example.yaml',
    '.env.example',
    'config/.gitkeep',
    'data/.gitkeep',
  ]) {
    assert.ok(!isIgnored(p), `${p} must NOT be gitignored`);
  }
});

test('every example init copies is present and parses', () => {
  for (const name of ['companies.example.yaml', 'gates.example.yaml']) {
    const doc = parse(readFileSync(join(ROOT, 'examples', name), 'utf8'));
    assert.ok(doc && typeof doc === 'object', `${name} should parse to an object`);
  }
  const rubric = readFileSync(join(ROOT, 'examples/rubric.example.md'), 'utf8');
  assert.match(rubric, /^# Scoring rubric/m);
});

test('the ai-forward signal set has both halves', () => {
  const signals = parse(readFileSync(join(ROOT, 'signals/ai-forward.yaml'), 'utf8'));
  assert.ok(Object.keys(signals.forward).length > 0);
  assert.ok(Object.keys(signals.legacy).length > 0);
  const terms = Object.values(signals.forward).flat();
  assert.ok(terms.includes('mcp'));
  assert.ok(terms.every((t) => t === t.toLowerCase()), 'terms are matched lowercased');
});
