#!/usr/bin/env node
import { VERSION } from '../src/index.js';

const USAGE = `deepjobs ${VERSION}

  A job search engine that reads the whole description, not the title.

Usage
  deepjobs init                       write config/ from examples/
  deepjobs setup                      interview-driven config (Claude Code skill)
  deepjobs run [options]              collect, dedupe, tag, gate, score
  deepjobs discover <name|--url>      find a company's board slug
  deepjobs report [options]           list what scored well

Run options
  --dry-run          collect and gate, persist nothing
  --limit <n>        stop after n new postings
  --no-score         skip the LLM stage entirely (free)

Report options
  --min <n>          only postings scoring at or above n
  --ai-forward       only postings tagged ai-forward
`;

const command = process.argv[2];

if (!command || command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (command === '--version' || command === '-v' || command === 'version') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const KNOWN = new Set(['init', 'setup', 'run', 'discover', 'report']);

if (!KNOWN.has(command)) {
  process.stderr.write(`deepjobs: unknown command "${command}"\n\n${USAGE}`);
  process.exit(1);
}

process.stderr.write(`deepjobs: "${command}" is not wired up yet\n`);
process.exit(1);
