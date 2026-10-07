# __PACKAGE_NAME__

AGH loop starter. Requires Node.js 24.10 or later and matching AGH package builds.

```sh
npm install
npm run build
npm test
```

The AGH packages in this preview are not yet on npm. Until distribution is available, supply local package artifacts or links through their public package names; keep application imports unchanged.

This one-turn loop asks the model on route demo/model demo-model, emits a reply, checkpoints completion and finishes. The local-dev profile supplies this keyless demo route. Install, trust and enable this package's main export through plugin management, then check `/admin/api/loops` for `__PACKAGE_NAME__@0.1.0` and run:

```sh
AGNES_PROFILE=local-dev agh --loop __PACKAGE_NAME__@0.1.0 -p "hello"
```

No API key is required; the reply is labeled as a local demo reply. For zero-build development, scaffold with `--local` into the daemon workspace's `.agnes/plugins` folder and start/restart the daemon before creating a session. See the [extension quickstart](https://github.com/AgnesAI-Labs/agnes-harness/blob/feat/agh-plugin-core/docs/extend/quickstart.md).

For real reasoning, change the route/model in this starter to a configured provider. Loop selection is bound at session creation. Completed checkpoints resume without another model request; the starter does not guarantee exactly-once reply delivery across a crash between emission and checkpoint. Add state and recovery rules for longer workflows.
