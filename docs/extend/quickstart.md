# Your first plugin in five minutes

English | [简体中文](quickstart.zh-CN.md)

[Author kit](README.md) · [Local plugins](local-plugins.md) · [Testing guide](testing.md)

Use Node.js 24.10 or later and an AGH source installation following [installation](../guide/install.md). The shortest path uses a local TypeScript plugin and the built-in keyless **Demo (local tool-aware, no API key)** model. No plugin build, SDK links or API key is needed.

## 1. Create directly in the plugins folder

Run these commands from the workspace where you will start the daemon. For the source preview, run the scaffolder from the AGH checkout:

```sh
mkdir -p .agnes/plugins
node templates/create-agh-plugin.mjs tool hello-tool .agnes/plugins/hello-tool --local
```

The package exports `./src/index.ts`. AGH transpiles it with jiti and provides the public author SDK imports, including TypeBox. You can also place it in `$AGH_HOME/plugins/hello-tool`; use the same configured home in every terminal. Local folders opt into trusted execution, so put only code you intend to run there.

The tool starter declares `agnes.kinds: ["tool"]` and `agnes.capabilities: {}` so inspection can show its type and requested capability scope without executing it. Update these declarations when adding functionality or side effects; the panel starter declares UI access and the loop starter declares model access.

## 2. Start AGH and open a new session

```sh
AGNES_PROFILE=local-dev agh web
```

For a source checkout without an `agh` command, use `node packages/cli/dist/local/agnes.mjs` in its place, after the installation guide's one-time runtime build.

Leave the daemon running. In another terminal with the same workspace, profile and home:

```sh
AGNES_PROFILE=local-dev agh tools
AGNES_PROFILE=local-dev agh --new -p 'call plugin_hello_tool'
```

CLI and daemon boot select a teaching fallback only for a fresh local-dev installation without a saved profile or explicit provider configuration: route `demo`, model `demo-model`. The labeled, deterministic adapter calls a named available tool with schema-derived example arguments, then reports its real result. You can provide explicit arguments, for example `call plugin_hello_tool {"message":"hello"}`. Unsupported schemas produce a helpful refusal. Check `/admin/plugins` or `agh package status` for hello-tool activation. Configure a real model for reasoning.

`--new` creates a fresh session using the latest published plugins; print mode reports its session key on stderr. Ordinary `agh -p` keeps workspace-session reuse. Inspect a pinned session with `agh tools --session <key>` (add `--json` for schemas and origins). SDK callers use `await session.tools()`; local admin callers use `GET /admin/api/tools/<encoded-session-key>`.

In Web, create a new session using **Demo (local tool-aware, no API key)** and submit `call plugin_hello_tool`. Existing explicit model configuration takes precedence. Asking the demo to create a plugin uses the available `plugin_helper_guide` and `plugin_helper_create` tools; review their prepared files and approve installation separately. If only the bundled creator is available, it reads `plugin_creator_guide` and scaffolds a canned tool through `plugin_scaffold`, then stops for review.

## 3. Edit and try again

Edit `src/index.ts`. Keep `ctx.signal.throwIfAborted()` and pass its signal into asynchronous work. Use `toolError('message')` for expected business refusal, and release clients/subscriptions through `ctx.effect()`.

The running daemon discovers new local folders and watches edits. Ordinary plugin changes activate a new generation without restart. Check `/admin/plugins` for activation errors, or request an immediate reload:

```sh
agh dev .agnes/plugins/hello-tool --profile local-dev
agh plugins reload hello-tool --profile local-dev
```

After activation, create a new session in Web or use `agh --new -p` to use it. Client panels publish updated assets with that generation. Existing sessions, including the CLI session reused in the same workspace, keep their pinned generation. Storage, sandbox and other process backends still require restart. See [hot reload](hot-reload.md) and [local plugins](local-plugins.md).

## 4. Optional compilation and tests

To compile a starter or run its author tests, build the preview SDK declarations once from the checkout, then link them locally. The preview Agnes SDK packages are not on npm; no registry install is needed:

```sh
nice -n 10 pnpm exec tsc -b packages/plugin-runtime packages/protocol packages/resource-control-runtime
node templates/link-local.mjs .agnes/plugins/hello-tool
npm --prefix .agnes/plugins/hello-tool run build
npm --prefix .agnes/plugins/hello-tool test
```

The linker is safe to repeat. The model-adapter starter uses public contract fixtures and does not require an `@agnes/ai` build. For a compiled installable package, scaffold without `--local`, build it, then follow [plugin management](../guide/packages.md). For a sidebar use `tool-with-panel`; for an independent agent loop use `loop`.

## Host-provided dependencies

Templates declare their SDK requirements in `package.json`:

```json
{
  "agnes": {
    "hostProvidedExternals": {
      "@agnes/plugin-runtime": "0.0.0",
      "@agnes/extension-api": "^1.4.0",
      "@sinclair/typebox": "~0.34.0"
    }
  }
}
```

This optional field maps exact public module specifiers to compatible versions. It uses the same range syntax as extension `apiRange`: exact versions, `*`, `^`, `~`, comparators separated by spaces, and `x` wildcards; unions and prereleases are unsupported. AGH checks the declaration before evaluating a package.

The supplied modules are `@agnes/plugin-runtime` (author exports), `@agnes/extension-api`, `@agnes/protocol`, `@agnes/cordis`, `@sinclair/typebox`, `@sinclair/typebox/value` and `@sinclair/typebox/compiler`. Host internals and testkit subpaths are not supplied. Installed snapshots, local plugins and isolated extension runners share these namespaces.

Bundle other dependencies for distribution, or supply them in the package's own declared dependency tree. Local discovery does not install dependencies, and source snapshots omit `node_modules`; merely running npm install before copying a plugin is insufficient. Missing-module errors name the dependency and suggest bundling/installing it; version errors suggest a compatible SDK range or AGH upgrade.
