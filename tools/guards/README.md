# Repository guards

English | [简体中文](README.zh-CN.md)

Run from the repository root through the [pinned toolchain](../../docs/maintainers/verification.md):
`pnpm test:guards` runs all guards, including their positive and negative fixtures.

## Source size: three different contracts

- `scope-line-count.test.ts` is **report-only**. `scope-line-count.json` is a reference snapshot of
  per-scope `countLines` totals. Growth prints a delta and never fails. Overlapping scopes must not
  be added together. The old ratchet paths have been renamed, including their consumers.
- `file-size.test.ts` is **hard**: production sources under packages/tools and handwritten bundled
  presentation sources have an 800 effective-line ceiling. `file-size-allowlist.json` freezes exact
  legacy file ceilings. An unlisted oversized file, growth beyond a ceiling or a stale entry fails.
- `function-size.test.ts` is **hard**: every function body in `core/src/execution/turn`,
  `host/src/runtime/generation` and `daemon/src/supervisor` is parsed with the pinned TypeScript AST.
  Declarations, expressions, arrows, methods, get/set accessors and nested callbacks are measured,
  including multiline signatures and nested text. The ceiling is **210 effective LOC**, using the
  same `countLines` as the file gate. The initial scan covers 99 files/1,997 nodes; the 20 existing
  oversized nodes are frozen in `function-size-allowlist.json`. Keys use path plus enclosing AST
  path, never line numbers. New oversized nodes, ceiling growth and stale entries fail. Named
  variables anchor within their lexical block; repeated callbacks retain structural ordinals.
  The report also prints statement counts and AST structure fingerprints/changes against the base.
  Nested function LOC overlaps its enclosing function and must not be summed. Compacting many
  statements onto one line can lower LOC; this is not a complexity metric.

The existing assembly gate remains separate: `assemble()` has a 20-physical-line ceiling,
`assemble.ts` 330 effective lines, assembly/CU stage files 480 effective lines, and formatted
column-zero functions in those stage files 210 physical lines. This change does not relax them.

File and function allowance ceilings are compared with the **protected-branch merge-base**.
New entries and increases fail even when source and JSON change together. CI reads the PR's base
SHA (main pushes use the previous tip) and fetches full history. Local checks use
`origin/feat/agh-plugin-core` (or `origin/main` after that branch is removed); missing history fails closed. New allowance files have exact reviewed
seed digests for their first introduction; thereafter the protected Git version owns the ceiling.

`pnpm guards:remeasure` refreshes the report and only tightens file/function allowances. It refuses
new oversized code, existing growth and increases already made in JSON. `--check` writes nothing
and also refuses stale entries. `--allow-increase` is restricted to a **separate maintainer budget
change** containing only budget JSON and maintainer documentation. It prepares revised budgets;
it does not bypass CI's protected-base checks. Authorizing an increase requires an explicit,
separately reviewed maintainer policy change. Do not combine it with feature work.

## Host official-business semantic fence

`host-business.test.ts` enforces: **Host contains no official business identities or implementation
dependencies; reviewed legacy exceptions only shrink.** It recursively scans the seven Host
packages' production sources, their templates and production dependency declarations. Official row
IDs and exports come from official manifests and shipped bundled payloads. Explicit legacy defaults
cover compatibility rows not yet declared there. Substrate packages and pure contract leaves are
classified separately; importing the observability implementation is still fenced.

The scanner checks static/re-export/type/dynamic imports, strings, template fragments, regexes,
known default symbols (including import aliases/namespace references), and simple literal aliases
in comparison branches. TS/MTS/CTS/TSX and handwritten JS/MJS/CJS/JSX share the policy. Production
`fixtures/` directories are scanned. Parse errors, empty roots and unclassified source suffixes fail.
Build outputs and test files are excluded. Computed strings are not fully proven by this static
check: review must reject concatenation intended to evade the fence, and capability/pin behavior
still needs admission tests. The guard does not grant or revoke runtime authority.

`host-business-allowlist.json` records each reviewed business exception by **exact path + enclosing
symbol + literal/import + syntactic role + occurrence ceiling + removal step**. No directory or
wildcard exceptions exist. New names/imports/comparisons, occurrence growth, stale exceptions and
changes that enlarge the allowance against the protected base fail. Partial removals must tighten
occurrence ceilings too. `remeasure` never creates Host exceptions. Initial migration steps A1–A5
identify future owners; this guard performs no migration.

Internal Host Symbols and event wire namespaces remain contracts. Exact control-plane, historical
origin/receipt, credential-format and local enforcement uses are reviewed separately in
`host-business-contracts.json`, with reasons instead of removal steps. They do not exempt whole
files or implementation packages; their locations/roles/counts also cannot grow against the base.
Typed community kind/capability declarations pass. The existing builtin extension-row completeness
guard is unchanged.

## Stylesheet layers

`css-layers.json` names the canonical order source and exact-count allowances for
raw inputs whose loader supplies a layer: skin CSS (`skin`), client-module CSS
(`app`) and generated Tailwind CSS (`ui`). Browser-only screenshot normalization
is an explicit test fixture allowance. Production stylesheets require layer blocks;
unlayered local imports must reference another checked stylesheet. New override
fragments in `packages/web/public/styles` fail the guard.

Move an allowance with its source and loader, rather than increasing its count to
hide an unlayered rule. A new wrapped input needs a reason and a demonstrated
layering boundary. The guard rejects stale entries and competing root layer orders.
