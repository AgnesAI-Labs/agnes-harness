# Explicit real-model authoring acceptance

These tools incur inference charges. Run from the repository root with Node 24 and the pinned pnpm version, after `pnpm install --frozen-lockfile` and `pnpm --filter @agnes/cli build:local`. Inject `AGH_DEMO_API_KEY` through secret handling for **each command**; never print it, save it in a script or pass it as an argument. `AGH_DEMO_MODEL` defaults to `deepseek/deepseek-flash`.

```sh
node --import tsx tools/authoring/real-eval.mjs skin
node --import tsx tools/authoring/real-eval.mjs itinerary
node --import tsx tools/authoring/real-eval.mjs todo
node --import tsx tools/authoring/real-eval.mjs behavior
```

Each command creates a fresh directory below `~/agh-real-eval/` with an isolated home/workspace and a free loopback port (never 4177/4178). Accounts are saved through the public SDK configuration API. Only the initial process receives the injected key; children receive an explicit isolated environment. Homes and redacted receipts are retained locally, outside Git. Do not upload complete homes or raw provider traces.

The child home and temporary directories are isolated on both Windows and macOS. Windows connections pass the daemon owner's process identity through the existing SDK verification; Unix socket connections retain the normal local transport.

There are no scenario retries. Track attempts externally and run a scenario at most three times. Each model turn has a 25-minute abort deadline; repetitive failed work can be cancelled earlier with the public SDK. `ask_user_question` forms receive the first declared enum choice or a fixed answer selecting a simple Chinese interface, profile-owned persistence and human review. Permission requests receive one-time approval for this synthetic evaluation; the real scenarios use the demo's full-access preset in the isolated workspace.

The three creation scenarios record the durable timeline, tool details, candidate trees, exact-hash tests and AGH usage projection. `review` means submitted for human review, not installed or published. Inspect receipts when a command fails. active-run.json records the session ID for read-only monitoring or cancellation through the public SDK. Billing is AGH's estimated USD, not a provider invoice; interrupted usage can be incomplete. Summing per-turn and session totals would double count.

The behavior runner feeds the JSON corpus, current guide/context and a synthetic tools-mode catalog (excluding unavailable run_code) to a **single-response** AGH provider call per case. It captures the proposed reply, next tool choice and plan without dispatching tools from synthetic receipts. A second call judges every `must`/`mustNot`; missing/duplicate judgments and malformed output fail. The judge uses the same model, so retain its evidence and audit semantic judgments manually. These plan scores do not establish successful authoring or browser behavior. Report failed and interrupted attempts too; synthetic and browser-runner failures are not model acceptance passes.

For a submitted or already published panel candidate, review its complete source and write `panel-plan.json` in that run directory. Example for an unchanged English to-do template:

```json
{"openText":"my-agh-plugin","heading":"my-agh-plugin","input":"New item","add":"Add","toggle":true}
```

Then, acting as the human administrator **only in that isolated home**, run:

```sh
node --import tsx tools/authoring/real-panel.mjs /absolute/evaluation/run candidate-<32-hex>
```

This approves only a submitted, passing exact-hash review through the normal admin API, launches headless Chromium, adds an item, optionally toggles it, reloads the page, restarts the daemon and verifies retained state. `path`, `fields`, `remove` and optional `confirmRemove` customize navigation, additional form inputs and deletion. Removal matches an accessible-name substring within the unique item row, including buttons whose accessible name includes the item text. Screenshots and browser errors stay beside `panel-evidence.json`; timestamped evidence preserves later attempts. If a platform repair requires an administrator to retest and submit an existing generated draft, explicitly add `--prepare-review`. This uses the normal test/submit APIs, stops on failing tests, preserves the candidate tree/hash, and records the administrator intervention separately from model completion. Publication failure is retained as failure; the runner never edits a candidate or weakens trust, validation or isolation.

Verify runner scoring with `pnpm exec vitest run tools/authoring/real-score.test.ts --maxWorkers=1`. Browser acceptance requires an installed Playwright Chromium; no automatic browser download is performed.
