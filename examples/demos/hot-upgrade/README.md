# Hot upgrade without interrupting work

English | [简体中文](README.zh-CN.md)

Publish a reviewed v2 while v1 waits for business review. New sessions use v2; restart the daemon and resume v1 with one read, classification and simulated send.

From the repository root, after installing dependencies and building the local CLI:

```sh
node examples/demos/hot-upgrade/run.mjs
node examples/demos/hot-upgrade/run.mjs --check
```

Each run creates and removes its own temporary home; `--check` approves only the synthetic demonstration. Any failed claim exits nonzero. See the [demo guide](../../../docs/guide/demos.md) for setup, optional real-model credentials and the proof boundaries.
