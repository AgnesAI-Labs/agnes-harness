# __PACKAGE_NAME__

AGH loop starter. Requires Node.js 24.10 or later and matching AGH package builds.

```sh
npm install
npm run build
npm test
```

The AGH packages in this preview are not yet on npm. Until distribution is available, supply local package artifacts or links through their public package names; keep application imports unchanged.

This one-turn loop asks the model on route demo/model demo-model, emits a reply, checkpoints completion and finishes. Configure that route/model for an actual deployment. Register main with the loops service and select this loop for a new session once loop selection is integrated. Completed checkpoints resume without another model request; the starter does not guarantee exactly-once reply delivery across a crash between emission and checkpoint. Add state and recovery rules for longer workflows.
