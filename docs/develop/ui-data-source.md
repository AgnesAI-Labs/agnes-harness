# UI data sources

English | [简体中文](ui-data-source.zh-CN.md)

[Intelligent UI contract](intelligent-ui.md#ui-data-sources)

This page is the index for the UI data-source contract. The full rules are in that section. Kind, provider and instance types, the result enum and the failure codes live in `@agnes/intelligent-ui-contract`. The package depends only on `@agnes/extension-api` and `@agnes/protocol`. There is no separate data-source package, and the kind is not a `KindMap` entry.

A surface stores the binding `{ "$source": "<id>", "params": {} }`. The host resolves it when the source is in the session's pinned generation catalog, its package is still enabled, and the trust decision's `capabilityHash` still covers that snapshot and the exact atom `uiData:<permission>`. `permission` is a name in the manifest list `agnes.capabilities.uiData`. That list does not accept `*` globs. Resolution uses the declaration sealed by `capabilityHash` at trust or load time. A later edit of the package directory does not add an atom. The ledger stores the binding and hashes. Cold recovery re-queries and degrades on failure. Resolved rows stay on the authenticated read path. `details.surface` keeps the binding.

A disabled or untrusted source also refuses an action that depends on it. A malformed source result degrades that component. A malformed literal still rejects the whole surface. The browser runs the existing structural checks before it renders a ready result.
