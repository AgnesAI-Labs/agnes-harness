<!-- Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified. -->

# Bench suites

The two JSON files in this directory are generated, not written by hand. They are derived from the
[JevLoop](https://github.com/parkavenue9639/jevloop) reference repository.

| | |
|---|---|
| Source repository | https://github.com/parkavenue9639/jevloop |
| Source commit | `61e7994` |
| License | Apache-2.0 (see `../../NOTICE`) |

Both files carry a top-level `source` record with the repository, commit, source file and license.
This project is independent: nothing here implies affiliation with, or endorsement by, TypeSafe, Jev
or the JevLoop authors.

## Files

- `fastapi-families.json`: the output of `suite_payload()` in `backend/benchmarks/fastapi_families.py`,
  unchanged except for the added `source` record. Three scenarios (observation reuse, generation,
  mixed), 20 turns in total, with Chinese goals, seed files (`inject_files`) and executable probes
  that print a unique marker.
- `smoke.json`: the six scenarios of `backend/benchmarks/scenarios.json` (English goals).

## Rewrite rules for `smoke.json`

The reference checks the workspace files from inside its own harness. Here every file check becomes a
`python -B -c` probe in `bash`, run in the session workspace after the turn:

- `files`: a file whose relative path contains `name` (case-insensitive) exists and, when `contains` is
  given, at least one such file contains it (case-insensitive).
- `any_file_contains`: one of the first 40 files contains the text (case-insensitive).
- `min_files`: at least that many files exist.
- Hidden files and directories (names starting with `.`) are not counted.
- A probe prints `SMOKE_<SCENARIO>_T<turn>_<n>_OK` on success and exits non-zero otherwise; `<turn>` and
  `<n>` start at 1.
- A probe whose check name contains a fragment listed in the reference `soft` array gets `soft: true`
  and does not count towards the hard checks.
- `goal`, `answer_contains` and `answer_max_chars` are kept as they are.

## Regenerating

Do not edit the JSON files by hand. To change them, change `../export-suites.py` and export again from
a checkout of the reference repository:

```sh
python3 -I packages/loop-jev/bench/export-suites.py <reference-repo-root> packages/loop-jev/bench/suites
```

The repository formatter collapses short arrays, so format the output afterwards. The content stays the
same; only the whitespace changes:

```sh
pnpm exec biome format --write packages/loop-jev/bench/suites
```
