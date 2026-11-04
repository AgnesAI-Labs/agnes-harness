# The long tasks, for reviewers

This file is for people reviewing the tasks. It sits beside the task folders, not in a fixture, and the
runner and the self-check copy a task's `fixture/` only, so no agent ever sees it
(`long-tasks.test.ts` checks that no fixture holds it or a tool's source).

Each long task is one session of ten milestones, one prompt each, with checks run right after it. Every
task has one hidden rule that its tool enforces and a release-like procedure that repeats at every
milestone, which a saved skill could do in one go. No prompt states the rule. The trap's error says that
something is wrong, not what to do: it names no value, flag or file of the fix, and finding the fix takes
a few steps of using the tool (another subcommand, a second try, comparing what it shows).

## Why the rule cannot be read off the workspace

The tool's readable source is `tool/<name>.py` in the task folder, outside the fixture. The fixture holds
it packed as `bin/<name>`: a short launcher that runs the zlib-compressed, base64-encoded source, so
`cat`, `grep` or `strings` on it show neither the checks nor the messages. `pnpm exec tsx
tools/rsi-eval/long-tools.ts` packs the sources again after an edit; `long-tasks.test.ts` fails when a
launcher does not run exactly its source. The tool keeps its state (published releases, the warehouse,
the deploy history, the test runs) compressed in a dot folder of the workspace, made on first use. The
README describes the normal workflow without the rule, the help text lists the commands without it, and
no fixture file shows it. `long-tasks.test.ts` checks the files, file names and help text of every
fixture for the words and values that would give each rule away, and that the trap's error line holds
none of the fix.

The agent can still learn the rule from the tool's behaviour, which is the point: that costs steps the
first time, and again whenever the agent has forgotten it (for example after a compaction). What it writes
into the workspace itself (a helper script, notes) is its own learning and is not prevented. The tools
remove what would show the rule in passing: `ship` takes the release note in and deletes `NEXT.md`, and
`ingest` takes a loaded file in and deletes it. Decoding a launcher by hand would show the rule; the
prompts ask the agent not to read the tools' source, as the other tasks do.

## long-01-release-train

Ten releases of four packages with `bin/ship` (build, inspect, publish, log).

- **Rule:** `bin/ship publish` takes a release note only when `packages/<name>/NEXT.md` contains the id of
  the build being published. The id is a hash of the package's name, version and sources; only
  `bin/ship inspect <name>` shows it (`build <id>`). Any change to the sources or the version after the
  build changes the id, so the note must be written after the last build.
- **Error:** `publish refused: the release note is not tied to this build`. Rebuilding does not help; the
  agent has to find `inspect` and see that its `build` line is what the note lacks.
- **Procedure:** change the code, set the version in `pkg.ini`, build, inspect, write the note with the
  id, publish, add the line to `CHANGELOG.md`. Every milestone releases a package (the last one two), each
  with a new id.

## long-02-vendor-import

Ten vendor CSV files (two vendors, orders and refunds) imported into a warehouse with `bin/ingest`.

- **Rule:** the importer ignores the header's names and reads columns by position, in the table's order
  (`bin/ingest schema <table>`: orders `id, placed, amount_cents, region`; refunds `id, order_id,
  amount_cents, reason`), and amounts must be whole cents. The vendors' files have other column orders
  (acme and bolt differ, and orders and refunds differ) and decimal amounts.
- **Error:** `batch rejected at line N: a value does not fit the table`, the same message for a value in
  the wrong column, a decimal amount and a refund of an unknown order. Fixing the order alone gives the
  same error again on the amount, so it takes the schema and a second try.
- **Procedure:** read the vendor's header, write a copy in the table's order with amounts in cents, load
  the copy, commit the batch it prints, check the total. Every milestone imports a file whose layout
  differs from the table's.

## long-03-config-rollout

Ten config changes to three services, deployed with `bin/rollout` to dev, canary, shadow and prod.

- **Rule:** `bin/rollout apply <service> prod` takes a change only when shadow runs exactly those values
  right now. Canary, the usual guess, does not count.
- **Error:** `prod refused: change <hash> of <service> is unproven`. Deploying to canary first gives the
  same error; `bin/rollout history <service>` shows that every past prod deploy followed a shadow deploy
  of the same change, which is how the agent can find it.
- **Procedure:** edit the config, lint, apply to shadow, apply to prod, check with `get`. Nine of the ten
  milestones go to prod (one is canary only); the last moves all three services.

## long-04-test-harness

Ten test cases added to four small text helpers, each fixed and recorded on a dashboard with
`bin/harness`.

- **Rule:** `bin/harness record <suite>` records only a run made with the suite's own seed (`--seed N`,
  where N is the seed `bin/harness suites` lists for that suite; slug, roman, wrap and plural each have a
  different one). A run without a seed, or with another seed, is refused.
- **Error:** `record refused: run N of <suite> is not reproducible`. The help lists `--seed`, but any seed
  but the suite's own is refused too; `bin/harness runs` and `bin/harness dashboard` show which seeds the
  recorded runs used, and `bin/harness suites` shows each suite's.
- **Procedure:** add the case file, fix the helper, run the suite with its seed until it passes, record,
  check the dashboard. Every milestone records a suite (the last one two), mostly a different suite with a
  different seed than the one before.

## What the self-check and the tests prove

- `self-check.ts`: each milestone's checks fail before its reference solution and pass right after it,
  with every earlier solution applied; the trap's `reproduce` (the natural first step) hits the signature.
- `long-tasks.test.ts`: the shape (one session, 8 to 12 milestones with checks, `maxRequests`, the oracle
  after the first milestone, the prompt that says not to read the tools' source); no prompt states a
  rule; the workspace and help show none; the natural solution fails the first milestone with an error
  that says no part of the fix, and fails at least three later milestones on the same rule.
- `agh/run-agh.test.ts`: no `trap.note` (the oracle's lesson) contains what a check expects or a whole
  solution step.
