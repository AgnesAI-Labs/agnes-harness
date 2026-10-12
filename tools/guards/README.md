# Line-count guards

Two guards cover source size. Neither needs a numeric edit when a file merely changes, so parallel
work does not conflict on them.

- `ratchet.test.ts` is **report-only**. It compares each scope in `ratchet.json` with its current
  `countLines` total and prints the delta; it never fails on growth. `ratchet.json` is a reference
  snapshot and is not updated per change.
- `file-size.test.ts` is **hard**: no source file may exceed 800 counted lines. Files already over the
  limit are listed in `file-size-allowlist.json` with a ceiling they may not exceed. The list only
  shrinks: remove an entry when its file drops to 800 or below; never add one. Split the file instead.
  There is no per-function limit; the repository has no cheap function-length tooling.

`pnpm guards:remeasure` refreshes `ratchet.json` and tightens the allowlist (drops entries that fit,
lowers ceilings); it fails if a file grew or a new file is over the limit. `--check` writes nothing.
`--allow-increase` re-baselines the allowlist after a reviewed merge; justify increases in the review.

Integrity and linear-growth checks elsewhere in the suite remain hard.

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
