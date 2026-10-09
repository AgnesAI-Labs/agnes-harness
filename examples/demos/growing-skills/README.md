# Agent grows its own skills

English | [简体中文](README.zh-CN.md)

Ask the Agent to create a reusable text statistics plugin. Review its source and passing tests, publish the exact reviewed candidate hash, then verify the next session uses it with installer=agent provenance.

From the repository root, after installing dependencies and building the local CLI:

```sh
node examples/demos/growing-skills/run.mjs
node examples/demos/growing-skills/run.mjs --check
```

Each run creates and removes its own temporary home; `--check` approves only the synthetic demonstration. Any failed claim exits nonzero. See the [demo guide](../../../docs/guide/demos.md) for setup, optional real-model credentials and the proof boundaries.
