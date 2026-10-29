# Use the Jev agent loop

English | [简体中文](jev-loop.zh-CN.md)

[Documentation](../README.md) · [TypeSafe Jev side model calls](typesafe-jev.md) · [Generic credentials](credentials.md) · [Bundles and profiles](../extend/bundles-and-profiles.md) · [Write a plugin](../develop/plugins.md)

The Jev agent loop (`agnes.jev@0.1.0`) is an optional agent loop. It ships with the AGH distribution as an optional bundled package, `@agnes/jev-loop`, and is not installed by default; the default loop stays `agnes.default`. You install it from the Marketplace.

## What it does

At every step the loop asks TypeSafe Jev, through a [side model call](typesafe-jev.md), what to do next: which phase the task is in, which tool to use and how to fill its arguments, or whether to answer. When Jev is confident, the loop runs the tool directly, without a conversation-model request. The conversation model is called only for three jobs:

- **Parameters:** Jev picked a tool but the arguments need writing, for example the content of a file.
- **Review:** Jev is unsure, or the last result needs judgement, so the conversation model decides the next call.
- **Answer:** the conversation model writes the reply to the user.

Jev chooses among the tools the default loop would offer in the same session, except `compact` and `run_code`, which only the default loop can use, and `tool_search` and `tool_describe`, which stay with the conversation model. A tool that is loaded during the turn joins the choice from then on. For the seven built-in file and shell tools (`ls`, `read`, `grep`, `find`, `write`, `edit`, `shell`) Jev also chooses the arguments when it can: a directory or file that an earlier `ls` result listed, a file that an earlier `find` or `grep` result listed, or a file that an earlier `read`, `write` or `edit` call was given as its path, can be listed or read directly, and up to four files can be read in one step. Every other tool, MCP and plugin tools included, gets its arguments from the conversation model. Approvals, budgets and the stop checks work as with the default loop.

The loop needs both a Jev route and an ordinary conversation model. The `state` and `questions` of every Jev call include the task text and excerpts of tool results, and are sent to the vendor; see [Network and privacy](typesafe-jev.md#network-and-privacy).

## Configure the Jev route

**In the settings page (recommended).** Add the Jev endpoint under Settings → Models & accounts → **Advanced: side models and task models** → **Side models**, as described in [Settings page](typesafe-jev.md#settings-page). The route that the page creates is named `account-<id>`; the entry's summary line shows the full name after the adapter name. Copy that name into the plugin's `jev.route` setting (next section). The plugin's default `jev.route` is `jev`, which does not match a page entry. Also check that `jev.model` is one of the model ids you saved on the entry; the default is `typesafe/jev-1.13-20260917`.

**In the user profile (headless or scripted use).** Declare the route in `AGH_HOME/profiles/<profile>/profile.yaml`, under `provider.routes`, using the route shown in [Profile route](typesafe-jev.md#profile-route). With the route name `jev`, the plugin's default `jev.route` matches it. This only works for a home where Settings does not manage any account: once an account is saved in Settings, the settings service supplies the whole `provider` block and the routes in `profile.yaml` are no longer used, so the plugin cannot find its route. In that case use the settings page.

`credentialRef` names a secret, never the key: use the `secret://generic/<UUID>` reference of a [generic credential](credentials.md), or a key in the profile's own secret store.

Other places do not work:

- The workspace file `.agh/profile.local.yaml` cannot declare routes. In this version it accepts only `extensionIsolation`, and any other key stops the runtime from starting with `E_DEP_MISSING`.
- A bundle's `profile` patch cannot carry a `provider` block.
- Do not name a Jev model in a preset slot: a slot is a conversation model.

## Install and configure the plugin

Jev is an optional package of the distribution, so it is not installed until you install it. Settings has no separate switch for it.

1. Open **Plugins → Marketplace**, search for **Jev Agent Loop** (its card is tagged **Running modes**) and choose **Install**.
2. AGH checks the package and opens a review page. Choose **Install and enable**: this installs, trusts and enables exactly the version you reviewed. **Install only** installs it without enabling. If the page offers only **Install**, your account cannot trust or enable plugins.
3. The package now appears on the **Plugins** page. Open **Jev Agent Loop** and use its **Settings** tab to fill in `jev.route` and `jev.model` (table below), then choose **Save configuration**. Changes apply to new sessions.

The loop appears in the loop lists described in [Choose the loop](#choose-the-loop) only after it is installed and enabled.

**Without the web interface.** The same package can be installed with the CLI, using the reserved source that the Marketplace card installs from. It works from any directory:

```sh
agh plugins add file:./bundled-plugins/jev-loop
```

The command shows the source, capabilities and any blockers, and after you confirm it installs, trusts and enables the reviewed version; add `--yes` for a script you have authorized. See [Install, enable, update, and remove plugins](packages.md) for the command. Set `jev.route` and the other keys in the profile, as shown next; a profile edit is the headless way to do what the Settings tab does.

**In a profile or a bundle.** Once `@agnes/jev-loop` is installed, its plugin row is `ext:agnes.jev/loop` and is enabled by default. You can configure it in the profile instead of the Settings tab:

```yaml
# AGH_HOME/profiles/<profile>/profile.yaml
composition:
  plugins:
    "ext:agnes.jev/loop":
      config:
        jev: { route: account-<id> }   # or jev, for a route declared in this profile
```

In a bundle the same `plugins` map goes in the bundle's `profile` patch. A row's `config` replaces the saved configuration as a whole. Setting `enabled: false` on the row turns the loop off without uninstalling the package. Changes apply to new sessions.

A home where `@agnes/jev-loop` is not installed has no `ext:agnes.jev/loop` row: a profile or bundle that names it is refused with `composition selects unknown ordinary plugin row: ext:agnes.jev/loop`. Install the package first.

The plugin's settings:

| Key | Range | Default | Meaning |
| --- | --- | --- | --- |
| `jev.route` | text | `jev` | Side-call route that serves the Jev model |
| `jev.model` | text | `typesafe/jev-1.13-20260917` | Model id on that route; pin a dated version |
| `jev.deadlineMs` | 1000–120000 | 15000 | Time limit for one Jev call, in milliseconds |
| `jev.maxRetries` | 0–3 | 2 | Retries within a step, for `RATE_LIMIT` only |
| `llmMaxAttempts` | 1–5 | 2 | Attempts for a conversation-model request that fails with a retryable error |
| `thresholds.escalate` | 0–1 | 0.5 | Confidence Jev must reach for its choice to run without review; below it the conversation model reviews the choice, or writes the arguments when only the arguments are uncertain |
| `thresholds.externalWriteMin` | 0–1 | 0.6 | Higher threshold for tools classed as external writes: tools that are not read-only and that the tool metadata marks as open-world, such as many MCP tools; none of the built-in tools is in that class |
| `thresholds.ambiguityGate` | 0–1 or `null` | 0.4 | While inspecting or verifying, a read-only choice below `escalate` still runs when Jev's ambiguity is at most this value; `null` turns this off |
| `thresholds.answerProgressFloor` | 0–3 or `null` | `null` | When Jev answers before any tool has run in the turn and reports progress below this value, the conversation model reviews; `null` turns this off |
| `stepCap` | 1–200 | 30 | Steps per turn before the turn ends with `max_steps` |
| `stateTokenBudget` | 4000–30000 | 24000 | Estimated tokens for the Jev state plus the longest question |
| `requestTokenBudget` | 8000–60000 | 48000 | Estimated tokens for the whole Jev request |

Omitted keys take the defaults above. A value out of range is refused: Settings does not save it, and the loop does not start with one written in a profile or bundle.

The loop needs a compaction engine. The default engine is selected unless you turn compaction off with `providers.compaction: null`; a session composed that way cannot use this loop.

## Choose the loop

After the package is installed and enabled, pick the loop for a new session in any of these ways:

- the profile: `providers.loop: { provider: agnes.jev, version: 0.1.0 }`;
- the admin **New session defaults** panel;
- the SDK: `client.createSession({ cwd, loop: { id: 'agnes.jev', version: '0.1.0' } })`;
- the CLI: `agh -p "prompt" --loop agnes.jev@0.1.0`.

An explicit choice wins over the admin default, which wins over the profile, which wins over `agnes.default`. A session keeps the loop it started with; changing a default affects new sessions only. See [Write a plugin](../develop/plugins.md) for the selection rules.

## What you see

- The admin loop list and the new-session loop picker show `agnes.jev@0.1.0` next to the default loop. The picker appears once two or more loops are available.
- **Plugins** lists the installed package, and its **Settings** tab holds the configuration page. The providers panel lists `typesafe-systemone` as **Payload requests only, no chat**.
- The conversation looks like one run by the default loop, with two differences: the notes the loop adds to a conversation-model request appear as runtime context, and a tool call that Jev chose directly follows an assistant message with no text. When the conversation model writes text before a call, the transcript keeps up to 8 KiB of it.
- The cost breakdown shows one **Side model call** row for each Jev call. A call whose usage was not reported is marked as estimated.
- The loop's own telemetry events (`jev.decide`, `jev.step`, `jev.metrics`) are kept in the session history and exports. The conversation view does not show them.

## When Jev is unavailable

If a Jev call fails (the route is missing, the credential is refused, the request is too large, the connection drops), the loop records the step as failed and asks again at the next step. It never falls back to running the turn on the conversation model alone. After the same failure three times in one turn, or three steps in a row that observe nothing new, the turn ends with the error `NO_PROGRESS_LIMIT`. The message starts with `No progress:` and names the last failure and its reason code; for a route that is not configured it contains `E_MODEL_UNKNOWN`. Check `jev.route` and `jev.model` against the route you configured. When Core refuses the Jev call for budget (the turn's credit is spent, or the call cannot be shown to fit the turn's cap, for example when the Jev route has no price), the turn ends with `budget` (`BUDGET_EXCEEDED`) instead.

A rate limit is retried within the step, up to `jev.maxRetries` times, waiting as long as the vendor asks, unless the wait would be longer than 10 seconds.

## Limits

This version does not yet:

- support pause or interrupt; steering a running turn is supported;
- run background jobs or child agents from the loop;
- keep more than 8 KiB of the text and thinking that the conversation model writes together with a call: the transcript cuts them to 8 KiB.

Within a turn, Jev is told which files were read and which have changed since. A file written or edited after it was read is marked to be read again; after a shell command has run, or after a call that could have changed files and whose result was lost, none of the earlier reads of the turn counts as current; a lost `ls`, `read`, `grep` or `find` does not change that. A call with the same tool and arguments is not run a third time when its last two runs returned the same result and no other call has changed files, or may have changed them, in between; the step is refused with `DUPLICATE_NO_PROGRESS` and the conversation model reviews the next step instead.

The loop does not work in a session whose model is offered `run_code`: the **ptc** preset (see [Programmatic tools and workflows](code-workflows.md)) and any custom preset that offers code mode, with the code runtime loaded. It also does not work in a session whose preset offers code mode only, even when the runtime is missing. Every turn of such a session ends at once with the error `JEV_UNSUPPORTED_DISCLOSURE`, before any Jev or conversation-model call. Use the default loop for it, or select a preset that does not offer `run_code`, such as **standard**.

A session that restarts in the middle of a turn continues from the loop's last checkpoint. A conversation-model request that may already have been sent is not sent again; the next step asks the conversation model to review instead.
