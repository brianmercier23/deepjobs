# Verification

This project is a port of a working private tool, so "it compiles" is not a
result. Every stage is diffed against the implementation it replaces, and the
numbers below are measurements rather than estimates.

Measured 2026-08-20 against 47 real boards.

## Collection

| | value |
|---|---|
| boards crawled | 47 (26 Greenhouse, 12 Ashby, 7 Lever, 2 SmartRecruiters) |
| board failures | 0 |
| postings returned | 2,929 |
| unique after dedupe | 2,897 |
| postings with a description body | 2,928 of 2,929 (99.97%) |
| elapsed | 21.2s |

The reference implementation, run against the same 47 boards on the same day,
returned **the same 2,929 postings, the same 2,897 unique hashes, and the same
0 failures**, in 76.7s.

Both crawls hit the boards directly and neither used a search API.

## Hash-set parity

The dedupe hash is `sha256(normCompany|normTitle|normLocation)`, so a
normalization difference between the two implementations shows up as a posting
present in one hash set and absent from the other.

| | value |
|---|---|
| unique hashes, this implementation | 2,897 |
| unique hashes, reference implementation | 2,897 |
| present in one and not the other | **0** |

Separately, and more strictly: all 2,929 collected postings had their company,
title and location run through both normalizers. **2,929 of 2,929 hashes
matched, 100.000%.** That isolates normalization from collection, so the result
does not depend on both crawls having seen the same postings.

## Description extraction

Both HTML-to-text implementations were given byte-identical Ashby markup and
returned strings of identical length (5,403 characters).

Description *lengths* differed on 202 of 2,929 postings across the two crawls,
which looked like an extraction difference and is not one:

> The same implementation, fetching the same board twice in a row, returned
> 6,636 characters and then 5,018 characters for the same posting.

An ATS can serve two different revisions of one posting seconds apart. So
description length is not a stable identity signal, and diffing on it chases
ghosts. The hash deliberately does not include the description.

## Reproducing

```bash
npm test                          # 78 tests, no API key, no network
node scripts/record-fixtures.js   # refresh the recorded board responses
```

Collector parity needs a board list and the reference implementation, neither
of which is in this repository.

## Gate parity

Both gates were run over one shared dump of the same 2,929 postings, so the
comparison isolates gate logic from collection and from any difference in what
the two crawls happened to see.

| | value |
|---|---|
| postings gated | 2,929 |
| passed, this implementation | 872 (29.8%) |
| passed, reference implementation | 872 |
| **decisions that differ** | **0** |
| **flag sets that differ** | **0** |
| reject reasons that differ | 77, all cosmetic |

The 77 are a deliberate improvement rather than a divergence: the reference
implementation reports the compiled pattern (`title contains 'director\s+of'`)
where this one reports the term a human wrote (`title contains 'director of'`).

## Reading the body instead of trusting the remote flag

Every job tool filters on structured remote metadata. An employer can tick
"remote" and then write a description asking for three days a week in an
office, so those postings pass every filter and are caught only by a person
reading the body, or by an LLM that has already been paid for.

Run over the 872 postings that pass the gate, of which 859 carry a REMOTE flag:

| flag | count | meaning |
|---|---|---|
| `REMOTE_CONTRADICTED` | 4 | declared remote, body requires time on site |
| `REMOTE_GEO_LIMITED` | 3 | declared remote, body restricts where you may live |

Real catches, all from postings whose location field says remote:

- *"Candidates located within commuting distance of NYC will work from our
  office 4-5 days per week"* — listed as "New York City / Remote"
- *"This is a remote position that must live near the Scottsdale, AZ or
  Chicago, IL office"* — listed as "Remote, AZ or IL"
- *"This person must be located in Eastern or Central Timezones"* — listed as
  "Remote, United States"

The first attempt reported 25 rather than 7, and 18 of those were wrong. A
bare `hybrid` pattern was matching *"a flexible hybrid work model that
balances remote focus with vibrant office collaboration"*, which is a benefits
blurb. Removing it took the count from 25 to 7. The number that matters here
is the one left after the false positives come out, because a gate that
mislabels a genuinely remote role is doing the one thing this gate must not do.

Known gap, left for tuning against the corpus: phrasing that puts the office
before the cadence, as in *"work in person at our office 4-5 days a week"*, is
not matched yet.

## The ai-forward signal set

Run over the same 2,897 unique postings. Tagging is regex over text already in
hand, so the cost is the whole point:

| | value |
|---|---|
| postings tagged | 2,897 |
| elapsed | 647ms |
| carrying a forward term | 994 (34.3%) |
| carrying a legacy term | 40 (1.4%) |
| carrying both | 7 |

34.3% is high because of what this corpus is: 47 hand-picked technology
employers in 2026, which is exactly the population that would name these tools.
It is not evidence that the set is loose. Precision was checked by pulling the
matched sentence for every high-frequency term, and the forward half held up:

- `agentic` (557) — *"own the quality infrastructure for our agentic product direction"*
- `mcp` (245) — *"Comfort with CLI-based tooling, MCP integrations, and AI agent frameworks"*
- `claude` (237) — *"use Claude Code, Cursor, and others as a core part of your workflow"*
- `rag` (115) — *"tool-calling agents, planning/execution loops, and RAG"*

The legacy half did not. `articulate` fired 245 times and was the English verb
essentially every time: *"you can articulate technical tradeoffs to engineers"*,
which is a communication requirement in half the job market rather than a
signal about an e-learning tool. Replacing the bare word with the product names
(`articulate storyline`, `articulate 360`) took legacy hits from 281 to 40.

Six terms never fired at all: `openai api`, `lms administration`, `nuvolo`,
`siebel`, `lotus notes`, `mail merge`. They are kept rather than pruned. This
corpus is technology employers; those terms belong to the facilities, CRE and
corporate-training postings the set exists to tell apart, and none of those
employers are in this board list yet.

**Not yet verified:** the claim that forward-tagged postings score 65-81 while
legacy-tagged score 25-40. That needs the scorer, which does not exist yet.
Prevalence and precision are measurable today; the correlation is not.

## Workday, live

Measured 2026-08-20 against `jll.wd1` / `jllcareers`.

| | value |
|---|---|
| list page size | 20 (50 and 100 both return HTTP 400) |
| reported total | 2000, which is a display cap rather than a count |
| `searchText` | filters server-side, the only platform that does |
| postings fetched with `searchText: "facilities manager"` | 40 in 4.1s |
| detail bodies | 8,090 characters, real ISO `startDate`, `timeType` |
| postings without a detail call | still carry title, location, URL and remote type |

Tenant resolution from a careers page:

- `https://www.jll.com/en-us/careers` resolves to
  `{tenant: jll, host: wd1, site: jllcareers}`.
- `https://careers.fortive.com` resolves to **nothing**, and correctly so. It
  is a 300KB WordPress marketing site that never names a board; the job search
  is another click in. A guess here costs a 422 that reads as a dead board, so
  discovery returns null and the user pastes the board URL instead.

## Still to verify

- The measured gain from body-based remote detection
- Scorer diff against a known-good scored set
- The ai-forward signal set reproducing its scoring split on a real corpus
- Following one level of careers-page links, to resolve boards like Fortive's
