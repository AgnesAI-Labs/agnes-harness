# Your first plugin in five steps (step 5 is optional)

English | [简体中文](quickstart.zh-CN.md)

[Author kit](README.md) · [Local plugins](local-plugins.md) · [Testing guide](testing.md) · [Import map](imports.md)

Use Node.js 24.10 or later and an AGH source installation following [installation](../guide/install.md). The shortest path uses a local TypeScript plugin and the built-in keyless **Demo (local tool-aware, no API key)** model. No plugin build, SDK links or API key is needed.

Prepare an isolated home and workspace (outside the product-command count). Keep the same environment and workspace for later commands; `pwd -P` avoids home safety checks rejecting parent symlinks such as macOS `/tmp`. Steps 1–4 each require one command; step 5 is optional verification. First success requires four product commands.

```sh
export AGH_SOURCE="/absolute/path/to/agnes-harness"
export AGH_HOME="$(mktemp -d /tmp/agh-author.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
AGH_WORKSPACE="$(mktemp -d /tmp/agh-workspace.XXXXXX)"
cd "$AGH_WORKSPACE"
```

## 1. Create the plugins folder

```sh
mkdir -p .agh/plugins
```

<a id="1-create-directly-in-the-plugins-folder"></a>

## 2. Scaffold the tool

```sh
node "$AGH_SOURCE/templates/create-agh-plugin.mjs" tool hello-tool .agh/plugins/hello-tool --local
```

The package exports `./src/index.ts`. AGH transpiles it with jiti and provides the public author SDK imports, including TypeBox. Keep this tutorial’s plugin below the daemon startup workspace: `dev` refuses paths outside it. Local folders opt into trusted execution; use `agh dev` to activate the folder and put only code you intend to run there.

The tool starter declares `agnes.provides: ["tool"]` and a `capabilities: {}` on its plugin entry so inspection can show its type and requested capability scope without executing it. Update these declarations when adding functionality or side effects; the panel starter declares UI and owner-store access and the loop starter declares model access. See [capability declarations](../guide/packages.md#capabilities) for the field format and examples; the empty object suits this pure echo tool. Declare the actual scope before adding file, network or process access.

<a id="2-start-agh"></a>

## 3. Activate the plugin

`dev` starts this home’s daemon when needed.

```sh
node "$AGH_SOURCE/agnes.mjs" dev .agh/plugins/hello-tool --profile local-dev
```

<a id="3-call-the-tool"></a>

## 4. Call the tool

```sh
node "$AGH_SOURCE/agnes.mjs" --new -p 'call plugin_hello_tool'
```

CLI and daemon boot select a teaching fallback only for a fresh local-dev installation without a saved profile or explicit provider configuration: route `demo`, model `demo-model`. The labeled, deterministic adapter calls a named available tool with schema-derived example arguments, then reports its real result. You can provide explicit arguments, for example `call plugin_hello_tool {"message":"hello"}`. Unsupported schemas produce a helpful refusal. Optional activation checks are in step 5. Configure a real model for reasoning.

`--new` creates a fresh session using the latest published plugins; print mode reports its session key on stderr. Ordinary `agh -p` keeps workspace-session reuse. Inspect a pinned session with `agh tools --session <key>` (add `--json` for schemas and origins). SDK callers use `await session.tools()`; local admin callers use `GET /admin/api/tools/<encoded-session-key>`.

## 5. Optional verification: inspect tools

```sh
node "$AGH_SOURCE/agnes.mjs" tools
```

## Other optional verification: status / Web

```sh
node "$AGH_SOURCE/agnes.mjs" package status --json
# Optional: open the Web workbench
node "$AGH_SOURCE/agnes.mjs" web
```

In Web, create a new session using **Demo (local tool-aware, no API key)** and submit `call plugin_hello_tool`. Existing explicit model configuration takes precedence. Asking the demo to create a plugin uses the available `plugin_helper_guide` and `plugin_helper_create` tools; review their prepared files and approve installation separately. If only the bundled creator is available, it reads `plugin_creator_guide` and scaffolds a canned tool through `plugin_scaffold`, then stops for review.

<a id="4-edit-and-try-again"></a>

## Edit and try again (after first success)

Edit `.agh/plugins/hello-tool/src/index.ts` in the workspace, for example by adding ``message = `hot-v2:${message}` `` before the return. Submit `call plugin_hello_tool {"message":"hello"}` again; a new session should return `hot-v2:hello`. Keep `ctx.signal.throwIfAborted()` and pass its signal into asynchronous work. Use `toolError('message')` for expected business refusal, and release clients/subscriptions through `ctx.effect()`.

The running daemon discovers local folders; after explicit activation it watches edits. Ordinary plugin changes activate a new generation without restart. Check `/admin/plugins` for activation errors, or request an immediate reload:

```sh
node "$AGH_SOURCE/agnes.mjs" dev .agh/plugins/hello-tool --profile local-dev
node "$AGH_SOURCE/agnes.mjs" plugins reload hello-tool --profile local-dev
```

After activation, create a new session in Web or use `agh --new -p` to use it. Client panels publish updated assets with that generation. Existing sessions, including the CLI session reused in the same workspace, keep their pinned generation. Storage, sandbox and other process backends still require restart. See [hot reload](hot-reload.md) and [local plugins](local-plugins.md).

After changing the result, also update the success assertion in `test/plugin.test.mjs` to `{ message: 'hot-v2:hello' }`; keep its invalid-input, cancellation and unload assertions.

<a id="5-optional-compilation-and-tests"></a>

## Optional compilation and tests

To compile a starter or run its author tests, build the preview SDK declarations once from the checkout, then link them locally. The preview Agnes SDK packages are not on npm; no registry install is needed:

```sh
AGH_PLUGIN="$PWD/.agh/plugins/hello-tool"
cd "$AGH_SOURCE"
mise exec -- node tools/toolchain/run.mjs exec tsc -b packages/plugin-runtime packages/protocol packages/resource-control-runtime
node templates/link-local.mjs "$AGH_PLUGIN"
npm --prefix "$AGH_PLUGIN" run build
npm --prefix "$AGH_PLUGIN" test
```

The linker is safe to repeat. The model-adapter starter uses public contract fixtures and does not require an `@agnes/ai` build. For a compiled installable package, scaffold without `--local`, build it, then follow [plugin management](../guide/packages.md). For an additional page use `tool-with-panel`; for an independent agent loop use `loop`.

## Host-provided dependencies

Templates declare their SDK requirements in `package.json`:

```json
{
  "agnes": {
    "hostProvidedExternals": {
      "@agnes/plugin-runtime": "0.0.0",
      "@agnes/extension-api": "^5.0.0",
      "@sinclair/typebox": "~0.34.0"
    }
  }
}
```

This optional field maps exact public module specifiers to compatible versions. It uses the same range syntax as extension `apiRange`: exact versions, `*`, `^`, `~`, comparators separated by spaces, and `x` wildcards; unions and prereleases are unsupported. AGH checks the declaration before evaluating a package.

The supplied modules are `@agnes/plugin-runtime` (author exports), `@agnes/extension-api`, `@agnes/protocol`, `@agnes/observability/contract`, `@agnes/intelligent-ui-contract`, `@agnes/git-worktree-contract`, `@agnes/plugin-runtime/deferred-contract`, `@agnes/cordis`, `@sinclair/typebox`, `@sinclair/typebox/value` and `@sinclair/typebox/compiler`. Host internals and testkit subpaths are not supplied. Installed snapshots and local plugins share these namespaces. Import kind tokens from these contract paths so loader reloads retain their identity.

Bundle other dependencies for distribution, or supply them in the package's own declared dependency tree. Local discovery does not install dependencies, and source snapshots omit `node_modules`; merely running npm install before copying a plugin is insufficient. Missing-module errors name the dependency and suggest bundling/installing it; version errors suggest a compatible SDK range or AGH upgrade.

## Clean up the trial

When finished, stop the daemon and the terminal running `web`, then remove only the temporary directories you created.

```sh
node "$AGH_SOURCE/agnes.mjs" daemon stop
# If you started Web, press Ctrl-C in that terminal.
rm -rf "$AGH_HOME" "$AGH_WORKSPACE"
```

For a staged business agent, scaffold `--template loop` and start from [`defineWorkflowLoop`](workflow-loops.md). Write business stages; the official helper owns confirmation, checkpoints and approval continuation.
