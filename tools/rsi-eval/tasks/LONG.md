# The long tasks, for reviewers

This file is for people reviewing the tasks. It sits beside the task folders, not in a fixture, and the
runner and the self-check copy a task's `fixture/` only, so no agent ever sees it
(`long-tasks.test.ts` checks that no fixture holds it or a tool's source).

Each long task is ten milestones, one prompt each, with checks run right after it, in five sessions of two
milestones over the same workspace. Each session is a new conversation, so an agent that learnt the rule in
one session does not have it in context in the next; only memory, skills or files carry it over. The
oracle's lesson is written after the first session, so its gap to `off` leaves out the first discovery.
Every task has one hidden rule that its tool enforces, met again at the first milestone of every session,
and a procedure that repeats at every milestone, which a saved skill could do in one go. No prompt states
the rule. The trap's error says that
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
  `bin/ship inspect <name> --verbose` shows it (`build <id>`); plain `inspect` does not. Any change to the sources or the version after the
  build changes the id, so the note must be written after the last build.
- **Error:** `publish refused: the release note is not tied to this build`. Rebuilding does not help; the
  agent has to find `inspect`, then its `--verbose` form, and see that its `build` line is what the note
  lacks.
- **Procedure:** change the code, set the version in `pkg.ini`, build, inspect, write the note with the
  id, publish, add the line to `CHANGELOG.md`. Every milestone releases a package (the last one two), each
  with a new id.

## long-02-vendor-import

Ten vendor files (two vendors, orders and refunds) imported into a warehouse with `bin/ingest`.

- **Rule:** the importer reads a comma-separated file by position and ignores the header's names. The
  columns must come in the table's own order (orders `id, placed, amount, region`; refunds `id, order_id,
  amount, reason`), amounts must be whole cents and dates ISO. `bin/ingest schema` lists the columns in
  alphabetical order and names no unit; the order shows in `bin/ingest peek` (values in table order), the
  unit in `bin/ingest total` (`… cents`).
- **The formats change.** From the third milestone on, every milestone brings a format not seen before: `;` with
  decimal commas, an extra `note` column, `.` thousands, renamed columns with `$1,253.48` amounts, a tab
  file, a second extra column, day-first dates. A converter written for the first file does not do a later
  one; the lesson ("by position, table order, cents, read each file's header") still does. Every amount
  converts exactly with `int(float(x) * 100)` too, so an agent's float conversion never commits a wrong
  total by a cent.
- **Error:** `batch rejected at line N: a value does not fit the table`, the same message for a value in
  the wrong column, a wrong number of values, a decimal amount and a refund of an unknown order. Fixing the
  order alone gives the same error again on the amount, so it takes `peek`, `total` and a second try.
- **Procedure:** read the vendor's header, write a copy in the table's order with amounts in cents, load
  the copy, commit the batch it prints, check the total. Every milestone imports a file whose layout
  differs from the table's.

## long-03-config-rollout

Ten config changes to three services, deployed with `bin/rollout` to dev, canary, shadow and prod.

- **Rule:** `bin/rollout apply <service> prod` takes a change only when shadow runs exactly those values
  right now. Canary, the usual guess, does not count.
- **Error:** `prod refused: change <hash> of <service> is unproven`. Deploying to canary first gives the
  same error. `bin/rollout status` shows the values each environment runs and no change ids;
  `bin/rollout history <service>` shows that every past prod deploy followed a shadow deploy of the same
  change, which is how the agent can find it.
- **Procedure:** edit the config, lint, apply to shadow, apply to prod, check with `get`. Nine of the ten
  milestones go to prod; the one that is canary only is the second of its session, so every session starts
  with a prod deploy. The last moves all three services.

## long-04-test-harness

Ten test cases added to four small text helpers, each fixed and recorded on a dashboard with
`bin/harness`.

- **Rule:** `bin/harness record <suite>` records only a run made with the suite's own seed (`--seed N`; slug,
  roman, wrap and plural each have a different one). A run without a seed, or with another seed, is refused.
  No command lists the seeds: `bin/harness dashboard` names the run each suite has on the dashboard, and
  `bin/harness runs [<suite>]` lists every run with its seed, so the agent has to match the two.
- **Error:** `record refused: run N of <suite> is not reproducible`. The help lists `--seed`, but any seed
  but the suite's own is refused too.
- **Procedure:** add the case file, fix the helper, run the suite with its seed until it passes, record,
  check the dashboard. Every milestone records a suite (the last one two), mostly a different suite with a
  different seed than the one before.

## What the self-check and the tests prove

- `self-check.ts`: each milestone's checks fail before its reference solution and pass right after it,
  with every earlier solution applied; the trap's `reproduce` (the natural first step) hits the signature.
- `long-tasks.test.ts`: the shape (five sessions of two milestones with checks in one workspace,
  `maxRequests`, the oracle before the second session, each session's first prompt saying not to read the
  tools' source); no prompt states a rule; the workspace, the help and the looks a careful agent takes
  before failing (`inspect`, `schema`, `status`, `suites`) show none; the natural solution fails the first
  milestone with an error that says no part of the fix, and fails the first milestone of every session on
  the same rule.
- `agh/run-agh.test.ts`: no `trap.note` (the oracle's lesson) contains what a check expects or a whole
  solution step.
