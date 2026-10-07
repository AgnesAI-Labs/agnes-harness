# Build a plugin by asking the agent

English | [简体中文](agent-built-plugins.zh-CN.md)

[Author guide](README.md) · [Local plugins](local-plugins.md) · [Testing](testing.md)

Start a session in the daemon's workspace and ask:

> Build a plugin that validates a customer reference, returns its normalized form, and explains invalid inputs. Write deterministic tests and install it locally.

The bundled **plugin creator** Skill guides the agent through this workflow:

1. `plugin_creator_guide` reads the instructions.
2. `plugin_scaffold` creates a new directory using the same five `create-agh-plugin` templates: tool, tool with panel, MCP/Skills, model adapter, or loop. The package export and tests point at source TypeScript.
3. The agent edits source with the usual read/write/edit tools and installs development dependencies through the normal shell tool. For the source-preview SDK, follow the [quickstart](quickstart.md) local linking instructions.
4. `plugin_test` runs `npm test`. Tool templates include real Host registration, refusal/cancellation checks and a deterministic `scriptedModel` tool invocation. Loops use the existing `driveLoop` scripted-model testkit. No live model account is required for these tests.
5. `plugin_install_local` reruns tests and copies passing source to `<session cwd>/.agnes/plugins/<name>`. It refuses an existing target and omits dependency/build directories.
6. Check `/admin/plugins`, then open a new session after activation. Until the generation reload service is connected, restart the daemon as described in [local plugins](local-plugins.md).

All code writes, dependency installation, tests and installation use the session's approval and sandbox policy. Denial, failure or cancellation stops the dependent step. You can inspect and edit the generated package before installing it. Global-home installation uses the usual approved file/shell tools and configured allowed paths; the dedicated installer targets the workspace.

Tests must assert your requested behavior, not merely the starter echo. The agent should report failed checks and any unverified integration. The bundled Skill and template assets are generated from `packages/base/extensions/plugin-creator/skills/plugin-creator/SKILL.md` and `templates/` by `node packages/base/extensions/plugin-creator/gen-assets.mjs`; regenerate them when either changes. They are embedded into the plugin creator so a bundled executable does not need a source checkout to scaffold.
