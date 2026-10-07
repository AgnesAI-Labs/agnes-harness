# __PACKAGE_NAME__

AGH loop starter. Requires Node.js 24.10 or later and matching AGH package builds.

__SETUP_GUIDE__

This one-turn loop asks the model on route demo/model demo-model, emits a reply, checkpoints completion and finishes. The local-dev profile supplies this keyless demo route. After this package activates through local discovery or plugin management, check `/admin/api/loops` for `__PACKAGE_NAME__@0.1.0` and run:

```sh
AGNES_PROFILE=local-dev agh --loop __PACKAGE_NAME__@0.1.0 -p "hello"
```

No API key is required; the reply is labeled as a local demo reply. For zero-build development, scaffold with `--local` into the daemon workspace's `.agh/plugins` folder and let the watcher activate it before creating a new session. See the [extension quickstart](https://github.com/AgnesAI-Labs/agnes-harness/blob/feat/agh-plugin-core/docs/extend/quickstart.md).

For real reasoning, change the route/model in this starter to a configured provider. Loop selection is bound at session creation. Completed checkpoints resume without another model request; the starter does not guarantee exactly-once reply delivery across a crash between emission and checkpoint. Add state and recovery rules for longer workflows.
