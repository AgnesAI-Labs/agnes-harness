# Exact ratchet remeasurement

Run from the repository root with the pinned pnpm version:

```sh
pnpm guards:remeasure --check
pnpm guards:remeasure --keys packages/web/src,packages/web/src/app --check
pnpm guards:remeasure --keys packages/web/src,packages/web/src/app
```

Without `--keys`, the tool selects every existing scope matching a source file
changed against `origin/feat/agh-plugin-core`, including committed, staged,
unstaged, untracked, deleted and renamed files. Fetch the integration ref first.
Test filenames and generated/build directories follow the guards' exclusions;
real source in `test` or `fixtures` directories still counts. A change can select
both a parent scope and its more specific scopes. PNGs and budget-only edits do
not select source scopes.

Counts use the guards' own `countLines`, `listSourceFiles`, `isTestFile` and
`matchesRatchetKey`. The tool updates both `ratchet.json` and the matching
`INITIAL_CEILING` numbers in `src/ratchet.test.ts` to the exact current count,
with no spare allocation. Comments, key order and surrounding formatting stay
intact. Unknown or empty source scopes, malformed budgets and mismatched key
sets fail before writing. It does not add/remove keys or justify source growth.

`--check` writes nothing, prints actual and both stored values, and exits 1 if
either value differs. Ordinary updates refuse the entire plan if any selected
count exceeds either stored value. An explicitly reviewed increase requires
`--allow-increase`; keep its justification in the branch review/report.

During a merge conflict, retain the integration version of **both** budget
files, resolve product changes, then run:

```sh
pnpm guards:remeasure --keys REVIEWED_COMMA_SEPARATED_KEYS --allow-increase
pnpm guards:remeasure --keys REVIEWED_COMMA_SEPARATED_KEYS --check
pnpm exec vitest run tools/guards/src/ratchet.test.ts --project fast --maxWorkers=1
```

Select all overlapping scopes touched by the branch. Default selection compares
the current tree to the fetched integration ref, so it is also usable after
rebasing/resolving source conflicts. Review the numeric diff before committing;
the command does not replace source review or the guard suite.
