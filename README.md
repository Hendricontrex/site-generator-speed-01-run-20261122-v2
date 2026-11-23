# Fast makefun-site drop-in, maximized

![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)
![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Hendricontrex/site-generator-speed-01-run-20261122-v2/rank.svg)
![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Hendricontrex/site-generator-speed-01-run-20261122-v2/reward.svg)

A faster drop-in for make.fun's own **makefun-site 1.0.0** — it builds the
same static site, byte for byte, only faster. This is the maximized
replacement for the earlier entry: same contract, more of the hot path
removed.

Entry for [site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
($100, 10 places × $10; deadline 25 November 2026 03:00 WIB).

## What it does

`solve.js` exports `run(input)`, which returns makefun-site 1.0.0's answer
for one case's input `{ site, templates, files }`: the output tree — every
page's `index.html`, the index and tag pages, `build-report.txt` and each
static file — as a JSON object of path to text, byte-identical to the
reference on every case.

`main.ts` is the driver the harness runs: it reads every case from
`/input/cases.json`, answers each one alone with `run`, and writes
`/output/answers.json` (`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in
for `/input` and `/output` outside a container).

## How it is faster

The reference spends most of its time in the Markdown renderer, which
lexes into token objects and calls the HTML escaper once per character, and
in the template renderer, which walks a node tree and builds a string per
node. This entry keeps the same semantics and trades that per-character,
per-node work for whole-run work:

- Markdown renders in one pass over the source with no token objects:
  lines are classified by direct character tests, the paragraph-end test
  is inlined into the hottest loop, and blocks write straight into the
  output array instead of joining per block.
- Inline spans are found with a single regex that jumps to the next
  construct or HTML special; plain runs are escaped whole, and code spans
  escape into the output without an intermediate string.
- Templates are parsed once, then compiled to plain JS functions
  (`new Function`) so rendering is straight-line code: no node-tree walk,
  no per-node switch, loop scopes and loop records reused across
  iterations, and leaf includes inlined at the include site under the same
  8-deep guard.
- Slugs and long dates are memoised per run; each post's card is built
  once and reused for its page, the index, the tag pages and the recent
  list; a page's scope is a fresh object over its card, so the shared card
  never gains page-only fields.
- Word counts use one tight character loop with a regex fallback only
  when the body holds Unicode whitespace; path resolution fast-paths
  relative targets without a dot segment.

Nothing is cached from one case to the next: every `run` call builds its
own caches, so each case is answered alone.

## Verification

- Practice set: all 3 cases byte-identical to the reference's
  `practice/reference/expected.json` (bench harness and the official
  scorer alike).
- Official scorer: `grade-local --kit <kit> --bot . --driver process
  --worktree` passes 3/3, L1 regrade reproduced byte for byte.
- Fuzz: 2,000 freshly generated small sites (pathological front matter,
  Markdown edge cases, broken templates, reserved dirs, drafts, slug
  collisions, duplicate paths, shuffled input order, CRLF bodies) compared
  against the reference — 0 failures; plus 30 full-size cases drawn from
  the competition's own generator with fresh seeds — 0 failures.
- Two real mismatches the fuzz caught were fixed and re-verified: an
  unclosed fence at end-of-input with a trailing newline (the reference
  keeps the trailing empty line as a code line), and page-only fields
  leaking into shared cards through mutation (the reference builds a fresh
  page scope object).

## Benchmark

Local measurements on a shared 1.5-CPU sandbox (noisy; compare ratios,
not absolutes). CPU time of `run`, average of 10 runs per case:

- practice total ≈ 190–200 ms across the 3 cases, ≈ 3.0× the reference
  (≈ 590–620 ms).
- Cold process (`node main.ts`, whole run including JSON parse/stringify):
  ≈ 610 ms vs the reference's ≈ 1,180 ms on the same machine, ≈ 1.9×.
  The server times fresh one-CPU containers, so the cold number is the
  one that counts; the gap between the warm and cold ratios is the fixed
  JSON and start-up cost every entry pays.
