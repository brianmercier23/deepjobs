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
other. Details and method in [docs/verification.md](docs/verification.md).

## Status

Under construction. The scaffold, the tracked signal set and the public/private
split are in place; collectors, gate, tagging, scorer and CLI are landing in
sequence. Nothing below is claimed as working until its section says so.

## How it works

```
collect -> dedupe -> tag -> gate -> score -> report
```

- **collect** hits ATS JSON APIs directly: Greenhouse, Lever, Ashby, Workable,
  SmartRecruiters, Workday. No search API in the middle, no dependency on what
  a search engine happened to index, no per-query billing.
- **dedupe** hashes normalized company, title and location, so the same role
  posted to two boards counts once, and a re-run can never overwrite a verdict
  you already recorded.
- **tag** applies [`signals/ai-forward.yaml`](signals/ai-forward.yaml) to every
  description body by regex. Free, and it runs on everything.
- **gate** rejects on location, compensation and title using the body text.
  Also free. This is the stage that makes the whole thing cheap.
- **score** sends only what survived to an LLM, with your rubric as the system
  prompt, and returns six sub-scores plus a rationale.

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
against a fictional example persona. `deepjobs setup` interviews you and writes
a real one.

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
  real. They are recoverable from a careers-page redirect, which is what
  `deepjobs discover --url` does.
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
