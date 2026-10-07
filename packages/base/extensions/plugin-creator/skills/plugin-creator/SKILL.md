---
name: plugin-creator
description: Build, test and install an Agnes plugin from a natural-language request.
---

# Build a plugin by asking the agent

1. Turn the request into a small observable contract: tool inputs, outputs, errors and side effects. Prefer the `tool` template; use a loop only when the request changes orchestration.
2. Call `plugin_scaffold` with a new workspace directory and lowercase package name. It uses create-agh-plugin templates and points the package export and tests at TypeScript source. No build is needed.
3. Read and edit the generated sources with normal session tools. Keep `agnes.plugins` declarations, cancellation and disposal. Declare side effects honestly in ToolMeta; never reduce approvals just to make a test pass.
4. Install development dependencies through the normal approved shell tool (`npm install`), or in a source checkout use `node templates/link-local.mjs <plugin-directory>` then install. Do not call a paid model.
5. Extend the generated tests for the requested behavior, invalid inputs and relevant failure paths. Use `createPluginTestHost` from `@agnes/plugin-runtime/testkit` to exercise tools through real registration. For model-driven behavior use `scriptedModel(replies)` or `driveLoop(factory, { replies, tools })`; each scripted `toolcall_end` should invoke the registered tool and assert its observable result. Supply explicit test I/O ports. Exhaustion must fail the test.
6. Call `plugin_test` and fix the plugin if it fails. Report failures accurately.
7. Call `plugin_install_local` with the tested directory and a simple folder name. This reruns `npm test`, refuses overwrite, and copies source to `<session cwd>/.agnes/plugins/<name>`. Work in the daemon workspace so it is discovered. For installation into `<AGNES_HOME>/plugins`, use the normal approved shell/file tools and applicable allow-path configuration.
8. Check `/admin/plugins`: source is `local`, with installed/enabled/failed status. Explain any missing dependency or activation error. Running sessions keep their plugin generation; try the new plugin in a new session once activated. Until the generation reload port is connected, restart the daemon.

Scaffolding, code writes, dependency installation, tests and installation must follow the session approval policy and sandbox. Refusal or cancellation ends the dependent step. Ordinary local plugins execute trusted Node code; only install code the user intends to trust.

Declare requested capabilities in package.json `agnes.capabilities` before installation: network hosts, filesystem read/write scopes, exec commands, secrets/credentials names, model, childAgents and UI. Keep scopes narrow. The admin policy may reject the request; inspect the fix hint and do not widen policy without approval.
