# __PACKAGE_NAME__

AGH loop starter. Requires Node.js 24.10 or later and matching AGH package builds.

__SETUP_GUIDE__

Use `@agnes/host/author-testkit` for author tests. See the [SDK import map](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/imports.md) for helpers, contracts and service kind tokens.

This business workflow starts from `defineWorkflowLoop`: add named stages with `run(ctx, state, signal)`, and return business evidence. The official helper owns checkpoints, cancellation, confirmations, approval continuation and completion. `workflowModelText` asks the session's effective model through its public prepared-request port. The local-dev profile supplies this keyless demo route. After this package activates through local discovery or plugin management, check the ready package status, then explicitly select `__PACKAGE_NAME__@0.1.0` and run:

```sh
AGNES_PROFILE=local-dev agh --loop __PACKAGE_NAME__@0.1.0 -p "hello"
```

No API key is required; the reply is labeled as a local demo reply. For zero-build development, scaffold with `--local` into the daemon workspace's `.agh/plugins` folder and activate it with `agh dev .agh/plugins/__SKILL_NAME__` before creating a new session. See the [extension quickstart](https://github.com/AgnesAI-Labs/agnes-harness/blob/feat/agh-plugin-core/docs/extend/quickstart.md).

For real reasoning, select a configured model in the profile. Core owns request route, contract and hashes. Loop selection is bound at session creation. Completed checkpoints resume without another model request. Add `confirm` to an action stage for a Proceed/Cancel decision, `deliverables` for official file publication, or `inputStage` for generic system notifications. Tool authorization stays separate; uncertain pending stages refuse replay. See the [workflow author guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/workflow-loops.md) for a worked example and the advanced custom-driver path.
