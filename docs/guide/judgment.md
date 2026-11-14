# Detect replies that stop before acting

English | [简体中文](judgment.zh-CN.md)

[Documentation](../README.md) · [Plugins](packages.md) · [TypeSafe Jev](typesafe-jev.md) · [Local models](local-model.md)

The optional **Judgment** plugin (`@agnes/judgment`) checks whether an assistant's final text promises to do something next but ends before doing it. For example, a reply that ends with “I'll inspect the failing test now” may receive one reminder to continue in the same turn.

Unexpected-stop detection is **off by default**. Real-session effectiveness evaluation has not been completed. Installing the plugin and selecting a model do not turn this check on: you must enable it explicitly.

## Install from the Marketplace

1. Open **Plugins → Marketplace**, find **Judgment**, and select **Install**. The package ships with AGH but is not installed by default.
2. Review the package source, its side model calling capability (`sideCall`), its access to conversation messages, and the excerpts it sends for judgment.
3. Finish installation, enable the plugin, then open its settings.

If the package is not installed, it performs no checks. If it is installed but detection is off or no usable judgment model is selected, it sends no judgment requests.

## Configure a judgment model, then enable detection

For Jev, open **Settings → Models & accounts → Advanced: side models and task models → Side models**. Add a Jev entry and save its key through the credential controls. Follow the [Jev setup guide](typesafe-jev.md) for route and model configuration.

The plugin automatically selects the sole native Jev route only when one model entry remains. If that route has multiple models, select a model explicitly. With multiple routes, select the intended route and model in the plugin settings; the plugin never chooses by catalogue order. A native judgment model may have one explicitly configured native fallback. It never switches automatically to a chat model after failure.

You can instead explicitly select a chat model as the primary judgment model. The plugin sends that model a text question and converts its answer to yes or no. These answers represent a binary decision, not a calibrated probability. To keep this judgment request on your machine, choose a model served entirely locally.

After choosing the model, enable **unexpected-stop detection** (`uses.stop.enabled`). Model and plugin configuration changes apply to new sessions; start a new session to use them.

## What happens at the end of a reply

The plugin considers the latest user request and the final assistant reply when that reply contains text and no tool calls. A native yes-probability of at least 0.5, or a parsed yes from an explicitly selected chat model, prompts one continuation in the current turn. The conversation includes a runtime-context note explaining the reminder. The main model decides what to do next under the existing permissions, approvals, step limits and budget.

The plugin can prompt continuation only once for the same user request. A session-history marker preserves that limit when the session is reopened after a restart. A cached judgment adds `（缓存）` to the reminder.

A judgment attempt may wait up to 5 seconds. With a configured native fallback it can make one more attempt; the end-of-turn hook has a 15-second limit. A missing model, invalid result, exhausted judgment budget or remaining failure lets the turn finish normally. Budget refusal does not trigger a retry. Cancellation or a new user message abandons the pending check; a late answer cannot resume the old turn.

## What is sent

For this check the plugin sends the selected judgment model:

| Content | Maximum excerpt |
| --- | --- |
| Latest user request | First 2,000 characters |
| Final assistant reply | Last 8,000 characters |
| Judgment question | The fixed unexpected-stop question and its criteria |

Credential redaction runs on the excerpts before they are sent. A remote model receives the remaining text, so these excerpts may still contain personal or confidential information. The selected provider and any configured gateway handle the request. Using a local judgment model keeps this particular model request local; it does not change where your main conversation model runs.

The plugin does not include the full conversation or a separate collection of files and tool results. Text already quoted in the selected excerpts is included within the limits above.

Native answers may be reused from a local memory cache. It holds at most 2,000 entries, expires them after 30 days, and evicts the least recently used entries when full. Cache keys are hashes; values contain answers and timestamps, not the source excerpts. The cache disappears when its plugin instance is released or the process restarts. Chat-model judgments are not cached. The durable continuation marker is separate from this cache.

## When the check does not run

- In child-agent sessions or turns marked unattended by the host.
- When the final reply contains a tool call, no eligible user request is available, or the same request has already received a continuation.
- In plugin isolation modes where the judgment calling capability is unavailable.
- During goal-driven work: after a human `/goal` command establishes goal suppression, checking stays paused until a genuine command from the same actor and source clears the goal with `/goal clear`. Pausing or completing a goal does not re-enable the check. The plugin is conservative, so an invalid goal command can also leave checking paused; `/goal` and `/goal show` alone do not establish suppression.

The check can miss unfinished work or misread a promise. It is not a completion verifier and never grants permission to perform an action. To stop using it, turn off `uses.stop.enabled`, or disable or uninstall the plugin.

## Semantic source finding and batch judgment

`uses.find.enabled` and `uses.batch.enabled` are independent opt-ins, both off by default. Human evaluation on 30 source queries and 200 batch items has **not been performed**; synthetic integration tests do not establish effectiveness. Configure a model, enable the desired use, and start a new session. A native primary exposes `find_relevant` and `judge_batch`; an explicitly selected chat primary exposes only `judge_batch`. Missing or invalid model readiness removes the tools. Child sessions, unavailable session projections, and isolated invocations without the authorized side-call port refuse execution.

`find_relevant({query, path?})` accepts a nonempty query up to 2,000 characters and a workspace path up to 2,048 characters. Before reading a requested subtree or file, it stats every ancestor from the trusted workspace boundary and refuses reported links or non-directory ancestors. It consumes at most 10,000 directory entries, excludes credential/lock/binary/build paths and reported links, and reads only each file's first 1 MiB for local content and filename ranking. It retains 128 paths, judges names in groups of 64, then freshly reads at most 20 selected file prefixes. Selected files have at most two 1 MiB reads; raw local-grep content is discarded. The existing filesystem port cannot guarantee atomic no-follow reads; detected metadata/revision changes are discarded and workspace authorization still applies.

The model receives the redacted query and candidate paths, then summaries of at most 256 original characters in groups of 46. Source ranges contain at most 8 KiB of original UTF-8 bytes, at most 24 ranges per selected file. At most 40 ranges with summary scores at least 0.45 receive full verification; scores at least 0.20 become ranked line ranges, merging adjacent matches. Full available context is redacted before original-coordinate windows are selected, so shrinking a secret never expands a window. Oversized lines may produce fragments. Limits, unreadable files, cancellation and failed judgments produce explicit partial results. Failed judgment is not evidence that no source exists: use grep.

`judge_batch({items, questions})` accepts 1–500 independent `{id, state}` JSON items with unique ids up to 128 characters. Each declared raw `{id, state}` item and the complete shared questions object must fit 1 MiB of serialized UTF-8 JSON before masking. Oversize input is refused rather than truncated. Validation, cloning, redaction and per-question sizing check the common deadline and yield to cancellation before any model dispatch. It validates the entire batch before sending anything, preserves question and option order, masks credential-named JSON values and redacts complete serialized states. Question instructions and criterion text are redacted too. A credential-shaped question id or choice key refuses the entire batch before dispatch; keys are never silently renamed. Choice questions require explicit `other` and `mixed` option keys. A state plus one question over 24,000 estimated tokens is refused; fitting requests are split only by questions at 48,000 tokens, never by item state. The selected provider receives the remaining JSON content and supplied questions. Redaction does not remove every confidential detail.

Native maximum probability below 0.7, or a choice of `other`/`mixed`, marks an item for review; exactly 0.7 is not low confidence. Chat results always need review and do not expose synthetic calibrated probabilities. Results include each completed answer or failure, pending ids, partial status and original accounting. Missing dollar billing is unknown, and credits are not dollars.

Find has a 20-second total deadline with 10-second attempts; batch has 60 seconds including validation, preparation and queueing. Both use the shared 16-request scheduler and retry a terminal retryable failure at most once. Cancellation returns completed work where available. Core budgets continue to apply; the plugin adds no dollar cap or price-availability refusal. Tool metadata declares read-only, non-destructive, open-world and idempotent behavior. Turn either use off, disable or uninstall the plugin to remove it for new sessions.

## Rule reminders and settings

Rule reminders are a separate opt-in and require a native judgment primary. For example:

```json
{"uses":{"rules":{"enabled":true,"items":[{"id":"review","text":"Review a record before acting on it.","tools":["read"]}]}}}
```

Up to 32 rules are supported, each with at most 1,000 text characters and 16 exact tool names. After a matching tool result, one native request checks all unreminded matching rules. It sends the configured rule text, the first 2,000 characters of serialized tool arguments and the last 8,000 characters of text output. Credential masking uses the complete input before selecting those original windows. Tool details and structured output are preserved and are not included in the judgment input.

A violation probability of at least 0.7 adds one untrusted text reminder while preserving every existing result field and content block. A durable hash-only marker prevents another reminder for that session, rule version and tool; changing one rule allows it to be checked again. Child sessions and unavailable session projections send no request. The whole check, including queueing, catalogue lookup and marker persistence, has a 1,500 ms deadline. It never retries, splits requests or uses fallback models. Refusal, errors, cancellation, saturation or a marker that cannot be confirmed leave the original result unchanged. Host budgets still apply.

The installed package also contributes **Judgment** under Settings → Plugins. The page shows bounded current-instance cache and use counters, model availability and the active configuration fingerprint. It queries only the package's read-only status service. Granted hook deadlines remain **unknown** without host authorization evidence. Configuration changes take effect for new sessions through the existing plugin configuration editor. Disabling, withdrawing trust or uninstalling removes the page and its visible statistics.

Usage details identify **Judgment** only for side calls with the exact judgment caller identity. A committed audit for the same effect supplies the use label; missing or unfamiliar labels show an unknown use. This changes neither recorded charges nor credit totals. Synthetic integration tests establish wiring and lifecycle behavior, not real-session judgment effectiveness.
