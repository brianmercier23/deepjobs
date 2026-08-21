# deepjobs

A job search engine that reads the whole job description, not the title.

Most job tooling works off titles and search-result snippets. That is the wrong
input. A posting tagged **Remote** that requires three anchor days in San
Francisco is an onsite role, and you only find that out in the body. A posting
titled *Operations Analyst* that turns out to be an automation build role is the
one worth applying to, and you only find that out in the body too.

`deepjobs` pulls full descriptions straight from applicant tracking systems,
tags them for free, throws out what was never viable, and spends money on an
LLM only for the small remainder.

## Measured

47 boards, 0 failures, 2,929 postings, 21.2 seconds, and a description body on
99.97% of them. Against the private implementation this replaces, the hash sets
match exactly: 2,897 unique postings each, zero present in one and not the
other, and zero gate decisions differ across all 2,929.

The economics are the point:

| stage | postings | cost |
|---|---|---|
| collect, dedupe, tag, gate | 2,929 | **$0** |
| score | 872 (29.8%) | ~$3.40 |
| the same crawl with no gate | 2,929 | ~$11.40 |

Scoring is $0.0039 a posting, so the free stages are worth about $8 a crawl.
Sampling temperature is pinned at 0 and 25 of 28 rescored postings come back
identical; against the implementation this replaces, the median difference is
zero.

Method for every number here, including the ones that came out wrong, is in
[docs/verification.md](docs/verification.md).

## Status

The engine runs end to end -- collect, dedupe, tag, gate, score, report -- with
167 tests that need no API key and no network. Every claim in this README is
measured in [docs/verification.md](docs/verification.md), including the one
that turned out to be false. Not yet published to npm.

## Getting started

```bash
npm install
node bin/deepjobs.js init                  # copies examples/ into config/
node bin/deepjobs.js run --no-score        # crawl, tag and gate, for nothing
```

`init` ships a rubric written for a fictional person, so a run produces
believable output before you have written anything. Then make it yours. If you
have Claude Code:

```bash
node bin/deepjobs.js setup     # installs an interview skill into .claude/skills/
```

Ask Claude Code to set up deepjobs. It reads your resume if you offer one, asks
six questions, and writes all three config files from the answers -- verifying
every board slug with `discover` first, because a guessed slug does not error,
it just returns nothing. Otherwise do it by hand:

```bash
node bin/deepjobs.js discover linear                       # find a board slug
node bin/deepjobs.js discover --url https://x.com/careers  # or read a careers page
```

Paste what it prints into `config/companies.yaml`, put your own rubric in
`config/rubric.md`, and add `ANTHROPIC_API_KEY` to a `.env` file. Then:

```bash
node bin/deepjobs.js run --limit 40        # scoring costs about $0.004 a posting
node bin/deepjobs.js report --min 60
node bin/deepjobs.js stats
```

`--limit` stops the crawl once it has that many *new* postings rather than
trimming afterwards, so a first run is seconds rather than minutes. `--dry-run`
does everything and writes nothing. `deepjobs --help` lists the rest.

## How it works

```
collect -> dedupe -> tag -> gate -> score -> report
```

- **collect** hits ATS JSON APIs directly across six platforms: Greenhouse,
  Lever, Ashby, Workable, SmartRecruiters and Workday. No search API in the middle, no dependency on what
  a search engine happened to index, no per-query billing.
- **dedupe** hashes normalized company, title and location, so the same role
  posted to two boards counts once, and a re-run can never overwrite a verdict
  you already recorded.
- **tag** applies [`signals/ai-forward.yaml`](signals/ai-forward.yaml) to every
  description body by regex. Free, and it runs on everything. It marks a
  posting worth reading, not a posting worth applying to -- measured, the tag
  barely moves the final score, and [docs/verification.md](docs/verification.md)
  shows the numbers rather than hiding them.
- **gate** rejects on location, compensation and title using the body text.
  Also free. This is the stage that makes the whole thing cheap.
- **score** sends only what survived to an LLM, with your rubric as the system
  prompt, and returns six sub-scores plus a rationale. Sampling temperature is
  pinned at 0: rescoring the same postings at the default moved one of them 30
  points, and a score that changes when the posting did not is not a score.

## Two dependencies

`yaml` and `@anthropic-ai/sdk`. That is the entire runtime dependency tree.

SQLite is `node:sqlite`, built into Node since 22.5, so there is no native
module to compile. HTTP is the built-in `fetch`. Tests are `node:test`. The CI
run needs no API key and no network, because collector and gate tests run off
recorded fixtures.

## Your rubric is yours

The three files that describe what you want out of your career are gitignored,
structurally, and there is a test that fails if that ever stops being true:

| Tracked | Ignored |
|---|---|
| `signals/ai-forward.yaml` | `config/rubric.md` |
| `examples/*.example.*` | `config/companies.yaml` |
| | `config/gates.yaml` |
| | `data/seen.db`, `.env` |

`deepjobs init` copies `examples/` into `config/` so the tool runs immediately
against a fictional example persona. `deepjobs setup` installs a Claude Code
skill that interviews you and writes a real one, verifying every board slug
before it writes it.

`signals/ai-forward.yaml` ships tracked on purpose. It is the one keyword input
that is not personal, and it is the part most worth extending.

## Notes that cost time to rediscover

Board APIs are not uniform and the differences are not documented anywhere.

- **SmartRecruiters answers HTTP 200 with an empty list for any slug**, real or
  invented. A zero proves nothing. `Ubisoft` returns nothing and looks dead;
  the real board is `Ubisoft2` and returns hundreds of postings. Verified
  2026-08-20.
- **Workable 404s an unknown slug**, so its zero is honest: real board, nobody
  hiring today. Same result, opposite meaning, and code that treats them alike
  is wrong about one of them.
- **Workday needs three separate parts** (tenant, `wd{N}` host, site path) and
  none can be guessed. A wrong site path returns 422 even when the tenant is
  real. A careers page that redirects to the board gives all three away;
  a careers page that is a marketing site with the job search another click in
  gives away nothing, and `discover` returns null rather than guessing.
- **Workday's page size is 20.** Not a preference: 50 and 100 both return 400.
  Its `total` maxes out at 2000 whatever the real figure is, so it is a
  stopping hint rather than a count. It is also the only platform that filters
  server-side, via `searchText`, which is what makes a tenant with thousands of
  roles usable at all.
- **Workday's `postedOn` is a phrase, not a date** ("Posted Today", "Posted 30+
  Days Ago"). The real date is on the detail call. Deriving one from the phrase
  makes a stale posting look fresh.
- **SmartRecruiters' list endpoint has no link a human can open.** Its only URL
  field points back at the API; `postingUrl` and `applyUrl` exist on the detail
  response only. Since descriptions are capped at 60 detail calls per company,
  a naive port scores postings nobody can open. The public URL is derivable,
  and a bare id resolves without the title slug.
- **The same board can serve two revisions of one posting seconds apart.** Two
  back-to-back fetches returned 6,636 and then 5,018 characters for the same
  job. Description length is not a stable identity signal, which is one reason
  the dedupe hash is built from company, title and location instead.
- **Greenhouse returns entity-escaped HTML inside a JSON string**, sometimes
  escaped more than once. `&amp;lt;p&amp;gt;` needs up to three unescape passes before
  it parses as markup at all.

## License

MIT. Copyright (c) 2026 Brian Mercier.
