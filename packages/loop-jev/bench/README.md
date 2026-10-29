# Jev loop bench

`run.mjs` runs a suite from `suites/` on two lanes, the default loop (`agnes.default@1.0.0`) and the
Jev loop (`agnes.jev@0.1.0`), in one headless host with the same chat model, the same seven tools
(`ls`, `read`, `grep`, `find`, `write`, `edit`, `shell`) and the same preset. Every
(scenario, lane, repetition) gets a fresh session, a fresh workspace in the system temp directory
and its own prompt-cache scope.
After each turn the suite's probes run in the workspace, outside the agent, and the turn is scored:
every hard probe exits 0 with its marker, every `answer_contains` text is in the final answer, and
the turn ended `completed`. Failed turns are kept, never re-run.

Run every command from the repository root. Build once first (the runner runs from source and
needs the native modules; `serve` needs the local distribution):

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/host build:native
pnpm --filter @agnes/system-node build:native
pnpm --filter @agnes/cli build:local
```

Keep `--out` outside any git repository, for example under `$HOME/agh-bench-out`, so the archive
you send back holds nothing else. The sessions' workspaces never live under `--out`: each one is
made in the system temp directory and copied to `--out/workspaces` when its cell ends. A workspace
inside a repository would let the host load that repository's `AGENTS.md`/`CLAUDE.md` into every
session on both lanes, and let the auto-approved tools reach the repository. The runner refuses to
start (exit 2) when the temp directory itself is inside a git work tree; point `TMPDIR` elsewhere
(on Windows, set `TEMP` and `TMP`).

## Running it with real accounts

The runner never sees a key. Both accounts live in a dedicated AGH home and are added in the Web
UI, which keeps the keys in the home's own credential store.

### 1. Prepare the bench home once

```sh
export AGH_HOME="$HOME/agh-bench-home"   # any empty directory that is used only for the bench
export AGNES_PROFILE=local-dev
node agnes.mjs serve                     # or `agh serve` with an installed distribution
```

Open the printed URL, then:

1. Settings → Models & accounts: add the chat model account (the model both lanes use) and verify
   it. Its route name and selected model are what the bench uses.
2. Settings → Models & accounts → Side models: add a TypeSafe Jev entry with the OpenRouter
   endpoint `https://openrouter.ai/api/v1`, a generic credential holding the key, and the model
   `typesafe/jev-1.13-20260917` (`contextWindow` 65536, `maxTokens` 32768, cost input 0.042). The
   entry's route is named `account-<id>`; the runner finds it by itself.
3. Do not configure the Jev loop under Plugins in this home; the runner supplies its
   configuration. The Jev loop is an optional bundled package (`@agnes/jev-loop`, Plugins → Market):
   the runner installs, trusts and enables it in the bench home on its first real run, the way the
   Market does, so you do not need to. `--dry-run` and `--rescore` leave the home untouched.
4. Stop `serve` (Ctrl-C). The bench and `serve` must not run on the same home at the same time.

### 2. Check the plan, then run

The probes call `python`. The runner points it at `--python`, else `BENCH_PYTHON`, else `python3`,
else `python` on `PATH`. The FastAPI suite needs `fastapi`, `httpx` and `pytest` importable by that
interpreter; the runner checks this before it starts and stops with a message if they are missing.

```sh
python3 -m venv ~/bench-venv && ~/bench-venv/bin/pip install fastapi httpx pytest
export BENCH_PYTHON=~/bench-venv/bin/python

# Plan only: shows the discovered routes and every cell, starts nothing, costs nothing.
pnpm exec tsx packages/loop-jev/bench/run.mjs --home "$AGH_HOME" \
  --suite packages/loop-jev/bench/suites/smoke.json --lanes default,jev --reps 1 \
  --out "$HOME/agh-bench-out/smoke" --dry-run

# Smoke run: both lanes, once (6 scenarios, 16 turns per lane). A check before launch, not a measurement.
pnpm exec tsx packages/loop-jev/bench/run.mjs --home "$AGH_HOME" \
  --suite packages/loop-jev/bench/suites/smoke.json --lanes default,jev --reps 1 \
  --out "$HOME/agh-bench-out/smoke"

# Baseline pilot: default lane only, once over the three FastAPI families (20 turns). Sets k.
pnpm exec tsx packages/loop-jev/bench/run.mjs --home "$AGH_HOME" \
  --suite packages/loop-jev/bench/suites/fastapi-families.json --pilot --out "$HOME/agh-bench-out/pilot"
```

The acceptance run, later, is three repetitions of both lanes with the `k` from the pilot, read
from the pilot's report (`--k <n>` gives it by hand). Without either, a run of both lanes with more
than one repetition warns and uses k = 1; the report records where k came from.

```sh
pnpm exec tsx packages/loop-jev/bench/run.mjs --home "$AGH_HOME" \
  --suite packages/loop-jev/bench/suites/fastapi-families.json --lanes default,jev --reps 3 \
  --k-from "$HOME/agh-bench-out/pilot/report.json" --out "$HOME/agh-bench-out/acceptance"
```

When the home has more than one chat account or more than one Jev entry, the runner lists them and
asks for `--chat-route <route>` or `--jev-route <route>`. `--chat-model` and `--jev-model` choose a
model on that route other than the account's selected one. Each turn has a 600 s watchdog
(`--turn-timeout-ms`); Ctrl-C cancels the running turn and still writes the report of what ran.

#### The read-heavy suite

`suites/read-heavy.json` tests the work the Jev loop is meant to do with fewer conversation-model
requests: long sessions that mostly list and read files and answer questions about them, with few
writes. It has two scenarios of thirteen turns, `read-heavy-code` (a small Python package) and
`read-heavy-docs` (an operations handbook), each seeded with 28 small files in its first turn. The
turns ask where something is defined, compare two modules or two policies, count call sites or
owners, and follow a reference chain across several files. Later turns go back to files read
several turns earlier and ask for a detail not asked before, compare files read far apart, read
again a file a teammate changed just before the turn (the runner writes the new content), and
answer from the note the session wrote itself; the last turn asks again for answers given earlier.
One turn per scenario writes a single file under `notes/`. Every probe checks that the workspace
outside `notes/` still holds exactly the seed files with their expected contents, and in the write
turn that the new file lists exactly the expected names. Answers are checked by exact names and by
`KEY=value` lines that the goals ask for, so a count cannot pass by a digit that appears by chance.
The probes need only the Python standard library, but the write probes call `str.removesuffix`, so
the interpreter that `--python`/`BENCH_PYTHON` points at must be Python 3.9 or newer.

```sh
pnpm exec tsx packages/loop-jev/bench/run.mjs --home "$AGH_HOME" \
  --suite packages/loop-jev/bench/suites/read-heavy.json --lanes default,jev --reps 1 \
  --out "$HOME/agh-bench-out/read-heavy"
```

The thresholds proposed for this suite are looser than the FastAPI gates: Jev-lane inference at
most 0.85 x the default lane's and cost at most 0.9 x. They are proposed, not adopted. The report's
Verdict section still applies the FastAPI gates (0.75 x k calls, 0.8 x cost), which do not apply
here; compare the totals with the proposed thresholds by hand. The suite is generated by
`suites/make-read-heavy.mjs`; see `suites/README.md`.

### 3. What it writes, and what to send back

Everything goes under `--out`:

| Path | Content |
|---|---|
| `report.md` | Per family, per turn, totals, Jev/default ratios, the three gates (or the pilot's k), the Jev lane breakdown and the checks below |
| `report.json` | The same as data: routes used, totals, verdict or pilot result, flags |
| `records.jsonl` | One line per turn: score and every check, answer, probe exits and output, ledger counters, steps, wall time, tool list |
| `events/<scenario>.<lane>.r<n>.jsonl` | Every ledger event of each session, for re-analysis |
| `workspaces/<scenario>.<lane>.r<n>/` | A copy of each session's workspace as the agent left it (the record names the temp path the session used) |
| `bundle.json` | The headless bundle the host was started with |

Send back `report.md`, `report.json`, `records.jsonl` and the `events/` directory (for example as
one archive of `--out` without `workspaces/`). They contain the suite's goals, the models' answers
and token counts; they contain no key, and the runner writes no key anywhere.

Exit codes: 0 every cell ran; 1 a cell could not run as planned (an error, a dirty workspace, a turn
that hit its watchdog), the lanes are not comparable or the counts do not add up (both below); 2 bad
arguments or setup (the message says what to fix, including a profile other than `local-dev` or
`enterprise`); 130 interrupted.

**Turn windows.** Each turn is counted from its own `turn/start` to its own `turn/end`; rows the
host writes between turns (the session title, reply suggestions) belong to no turn. For every
session the runner checks that the per-turn inference counts, and the per-turn Jev side calls, add
up to that session's ledger rows (`sessionChecks` in report.json). When one does not, report.md opens
with COUNTS DO NOT ADD UP, the session is flagged and the exit code is 1.

**Comparable lanes.** The two lanes count only when they send the same tool schema. After each cell
the runner compares the first request's `tool_schema_hash` of every scenario and repetition that has
run on both lanes. As soon as one pair differs it stops, without running the remaining cells, and
the report says NOT COMPARABLE at the top, judges no gate (`verdict.valid: false` with the reason)
and the exit code is 1. The same happens when no pair could be compared at all. The comparison needs
one cell of each lane, so at least the first scenario runs on both lanes before a mismatch can be
seen.

The checks section also flags, without failing anything: a pair whose hash could not be compared
because a lane sent no request, a first request of a cell that read more cached tokens than the tool
definitions could account for, turns whose inference rows do not match the Jev loop's own count of
model attempts or whose side-call rows on the Jev route do not match its Jev calls, side calls on
other routes, dropped Jev telemetry, turns that ended at the no-progress limit, ledger rows whose
model has no catalogue price, and timeouts.

## Rescoring a finished run

`--rescore <out dir> --out <new dir>` recomputes a finished run from its own `events/` and
`records.jsonl`: every per-turn metric with the current turn windows, the session checks, the
pilot's k or the gates (with `--k`/`--k-from`, or the k the original report used). Probe results,
answers and checks are kept. It needs no home, key, network or Python and never writes into the
original directory. Rows without a billed cost count as 0 there, since no catalogue prices are at
hand; the cache-read check is carried over from the original report.

## Without the Web UI

In a home whose Settings hold no account, the runner reads the routes from
`AGH_HOME/profiles/<profile>/profile.yaml` instead, as the host does: one route with
`api: typesafe-systemone` (see `docs/guide/typesafe-jev.md`, Profile route) and one chat route, the
keys in the profile's secret store. This works only while Settings holds no account: once one is
saved there, Settings supplies the whole `provider` block and the profile's routes are not used.

`--fake` builds such a home by itself under `--out/home`: a loopback stand-in for Jev, the built-in
scripted chat model that always answers `ok`, and a placeholder key. It checks the plumbing (boot,
sessions, events, probes, scoring, report) and says nothing about either loop.

The placeholder key uses the normal credential store under `--out/home/secrets`, with private
access on macOS and Windows. If writing the temporary profile fails, the loopback stand-in closes
before the error is returned.

## Implementation notes

How the runner fits the host as it is in this version:

- The routes are not written anywhere. They come from the home, read with the host's own
  `readConfigurationProfileInputs` over the configuration service's `profileInput()`, the same two
  calls the host makes at boot. `.agh/profile.local.yaml` cannot hold routes in this version (it
  accepts only `extensionIsolation`), and a bundle may not carry a `provider` block.
- The plugin row (with `stepCap` and the discovered `jev.route` and `jev.model`), the tool set and
  the per-cell presets travel in the headless bundle. The host adds an operator bundle's presets to
  `presets.allowed` by itself, so nothing is written into the home's profile.
- The profile name must be one of the built-in templates (`local-dev`, `enterprise`): the host
  layers the profile over the template of the same name.
- The headless host keeps its sessions and settings in a temporary data directory, so a system
  prompt saved in the Web UI does not reach the bench sessions and cannot override the per-cell
  cache scope.
- The chat model is set on every session (`primary` slot) to the discovered route and model.
- The host names each new session with one background call to the chat model. Those `title` rows are
  counted under `purposes` but left out of inference and cost, the same on both lanes.
- Only side-call rows on the discovered Jev route are Jev calls. The host makes side calls of its own
  too (reply suggestions ask the chat model for a follow-up question after each completed turn, on
  both lanes); those rows are reported per lane under "Other side calls" (count, tokens, cost, over
  the whole session) and stay out of the Jev counts, the cost and every gate. Reply suggestions are a
  built-in extension row, and in this version neither a headless bundle nor a profile can switch one
  off: `composition.plugins` names only ordinary plugin rows (the host refuses the extension's id),
  a preset cannot remove the inherited fast slot it uses, and the Settings model slots are not read
  by a headless host.
- Before the first turn the runner checks that the workspace holds only what it wrote (`.gitkeep`
  for the generation family, nothing otherwise); otherwise the cell's turns are recorded as not run.
- The cache check compares the first request's `cacheRead` with the tool definitions' size estimated
  as UTF-8 bytes / 3.
- The pilot also reports how many tool calls each tool-using inference request made (mutable and
  read-only), next to k.
- Jev calls: each Jev-lane record has `jevDecide` (calls by status, total and largest latency, and
  the latency of calls whose status is not `ok`), summed in the report's Jev lane section. The time
  in failed Jev calls is that latency sum; it does not include the rest of a failed step. Anything
  finer, such as per-step timing, is in the raw `events/` files (`jev.decide`, `jev.step`).
- The startup directory of the headless host is also a temp directory, and `AGH_HOME` is set to
  the bench home, so no user-wide instruction file from another home reaches the sessions.
