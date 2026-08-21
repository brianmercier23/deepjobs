// Where the personal half of this tool lives.
//
// `examples/` is tracked and `config/` is gitignored, and that split is the
// whole privacy design: the rubric describing what someone wants from their
// career, the list of employers they are watching, and the salary floor they
// will not go below are the three files most worth not publishing by accident.
// `init` copies one to the other. Nothing here ever writes into `examples/`.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_FILES = [
  { name: 'rubric.md', example: 'rubric.example.md', what: 'what you want out of a role' },
  { name: 'companies.yaml', example: 'companies.example.yaml', what: 'the boards to crawl' },
  { name: 'gates.yaml', example: 'gates.example.yaml', what: 'what to reject before paying' },
];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function configPath(name, dir = 'config') {
  return join(dir, name);
}

/**
 * Copy the examples into `config/`.
 *
 * Never overwrites without being asked. The one file here that takes real work
 * to write is the rubric, and silently replacing someone's is the kind of
 * mistake a tool only gets to make once.
 */
export function initConfig({ dir = 'config', force = false, examplesDir = join(PACKAGE_ROOT, 'examples') } = {}) {
  mkdirSync(dir, { recursive: true });
  const written = [];
  const skipped = [];
  for (const file of CONFIG_FILES) {
    const target = configPath(file.name, dir);
    if (existsSync(target) && !force) {
      skipped.push(file);
      continue;
    }
    copyFileSync(join(examplesDir, file.example), target);
    written.push(file);
  }
  return { written, skipped };
}

function readYaml(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`${what} not found: ${path}. Run \`deepjobs init\` first.`);
  }
  try {
    return parse(text) ?? {};
  } catch (err) {
    throw new ConfigError(`${path} is not valid YAML: ${err.message}`);
  }
}

export function loadGates(path = configPath('gates.yaml')) {
  return readYaml(path, 'gate config');
}

/**
 * Flatten the companies file into the target shape the collectors take.
 *
 * The file is grouped by platform because that is how a person thinks about
 * it; the crawler wants a flat list. Workday entries carry three parts instead
 * of a slug and are passed through whole, since none of the three is
 * derivable from the other two.
 */
export function loadCompanies(path = configPath('companies.yaml')) {
  const raw = readYaml(path, 'company list');
  const targets = [];
  for (const [platform, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const value = typeof entry === 'string' ? { slug: entry } : { ...entry };
      if (platform === 'workday') {
        if (!value.tenant || !value.site) {
          throw new ConfigError(`workday entries need tenant, host and site: ${JSON.stringify(entry)}`);
        }
        value.host ??= 'wd1';
      } else if (!value.slug) {
        throw new ConfigError(`${platform} entries need a slug: ${JSON.stringify(entry)}`);
      }
      targets.push({ platform, ...value });
    }
  }
  if (!targets.length) throw new ConfigError(`${path} lists no boards`);
  return targets;
}

/**
 * Load a `.env` file into the environment without adding a dependency.
 *
 * Deliberately does not override anything already set: an API key exported in
 * the shell should win over one left in a file months ago.
 */
export function loadEnv(path = '.env') {
  if (!existsSync(path)) return 0;
  let n = 0;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined) {
      process.env[key] = value;
      n += 1;
    }
  }
  return n;
}
