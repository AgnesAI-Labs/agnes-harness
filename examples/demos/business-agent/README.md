# Business agent as a plugin

English | [简体中文](README.zh-CN.md)

Install the existing support-triage bundle, verify its Loop and tools beside an isolated default Agent, then disable it while the old session continues.

From the repository root, after installing dependencies and building the local CLI:

```sh
node examples/demos/business-agent/run.mjs
node examples/demos/business-agent/run.mjs --check
```

Each run creates and removes its own temporary home; `--check` approves only the synthetic demonstration. Any failed claim exits nonzero. See the [demo guide](../../../docs/guide/demos.md) for setup, optional real-model credentials and the proof boundaries.
