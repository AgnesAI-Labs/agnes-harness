# Research bundle

A static package: no executable entry, runtime imports or build step. The `base` bundle supplies a read-only tool policy; `research` extends it with `example.dag@1.0.0`, `sliding-window`, and a `research` preset extending `standard`.

Install, trust and enable this directory and its two companion packages using [package management](../../../docs/guide/packages.md). Build the [sliding-window package](../../compaction/sliding-window/README.md) first. Package references declare dependencies; they do not download, trust or enable them. The `file:` references are documentation for this source checkout, not paths read by Host resolution.

Select `@agnes-example/research-bundle#research` in admin, save, then restart the Host. Alternatively add this to the user profile:

```yaml
bundles: ["@agnes-example/research-bundle#research"]
```

Run `agh config dump --preset research` to inspect the desired configuration and its sources. Select `research` for a new session. The DAG loop executes its configured graph; add graph configuration through the DAG plugin row as described in [its example](../../loops/dag-loop/README.md). The tool policy denies any tool whose metadata does not assert `isReadOnly: true`, including DAG-scheduled tools. It does not grant filesystem, network or approval permissions.

See [Bundles and profiles](../../../docs/extend/bundles-and-profiles.md) for lifecycle limits and separate Host generation compilation.
