# Build a plugin by asking the agent

English | [简体中文](agent-built-plugins.zh-CN.md)

[Author guide](README.md) · [Local plugins](local-plugins.md) · [Testing](testing.md)

Use a model route that can call tools and edit files, then start a local session in the daemon's workspace. The built-in Demo is a teaching reply, not an autonomous plugin author. Ask:

> Build a plugin that validates a customer reference, returns its normalized form, and explains invalid inputs. Include deterministic tests, run them, and ask me before installing it.

The default bundled **Plugin Helper** exposes these three tools:

1. Call `plugin_helper_guide` with kind: tool (or skill / skin). It returns version-matched guidance and a complete self-contained JavaScript template. This helper does not scaffold all five TypeScript author-kit templates.
2. Implement the requested behavior and add deterministic tests to the returned file bundle. Keep the package name, row ID, named export, inject services and tool name consistent. The helper accepts text-only ESM without dependencies or package scripts. Advanced loops, adapters and client panels use the [author quickstart](quickstart.md).
3. Call `plugin_helper_create` with files: [{ path, content }, ...]. It validates the bundle, writes a fresh directory under the session workspace's .plugin-helper folder and returns a `prepared proposal`, directory, integrity and capability preview. This saves source; it does not install or execute it.
4. Review the saved files and run the tests through the normal approved shell tool, for example `node --test <returned-directory>/test.mjs` for a self-contained node:test fixture. Plugin Helper does not run tests automatically. If a test fails, report it, cancel the proposal with `plugin_helper_install` action: cancel, repair the file bundle and prepare a new proposal. Edits to the saved directory do not update the immutable `prepared proposal`.
5. Call `plugin_helper_install` with action: commit and `proposalId` only after the review and tests pass. The local confirmation separately authorizes installing, trusting and enabling those exact prepared bytes. Creating the source is not installation consent. Denial or cancellation stops this workflow.
6. If the reply is `submitted`, end the turn. On a later turn call `plugin_helper_install` with action: status and the same `proposalId`; check actual running state in Settings → Plugin management or /admin/plugins before claiming success. New tools become available on later turns; a `submitted` receipt is not proof of activation.

There is no default Plugin Helper test/scaffold tool beyond the names above. Use the ordinary approved shell and file tools for author tests. The optional source extension `agnes/plugin-creator` is a separate author-kit integration, not the default bundled helper.

All file writes, tests and installation follow session approvals and sandbox policy. Do not bypass a refusal with shell or configuration changes. Ordinary installed plugins execute trusted Node code; inspection and passing tests do not sandbox module initialization. Tests must assert your requested behavior, including invalid inputs, not merely the starter echo. Report failed checks and unverified browser effects separately.

For continued source development, use the [local plugins](local-plugins.md) roots and [hot reload](hot-reload.md): the running daemon watches edits, or use `agh dev <folder>` / `agh plugins reload <id>` for an immediate reload. Ordinary plugin edits require no restart. New sessions use the new generation; existing sessions retain their pinned version.

The bundled Plugin Helper implementation and templates live in packages/package-manager/bundled-plugins/plugin-helper. The separate creator extension embeds its author-kit assets using node packages/base/extensions/plugin-creator/gen-assets.mjs; regenerate those assets when its Skill or templates change.
