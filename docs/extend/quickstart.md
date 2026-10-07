# Your first plugin in five minutes

English | [简体中文](quickstart.zh-CN.md)

[Author kit](README.md) · [Local plugins](local-plugins.md) · [Testing guide](testing.md)

Use Node.js 24.10 or later and an AGH source installation following [installation](../guide/install.md). The shortest path uses a local TypeScript plugin and the built-in keyless **Demo (local scripted reply)** model. No plugin build, SDK links or API key is needed.

## 1. Create directly in the plugins folder

Run these commands from the workspace where you will start the daemon. For the source preview, run the scaffolder from the AGH checkout:

```sh
mkdir -p .agnes/plugins
node templates/create-agh-plugin.mjs tool hello-tool .agnes/plugins/hello-tool --local
```

The package exports `./src/index.ts`. AGH transpiles it with jiti and provides the public author SDK imports, including TypeBox. You can also place it in `$AGH_HOME/plugins/hello-tool`; use the same configured home in every terminal. Local folders opt into trusted execution, so put only code you intend to run there.

## 2. Start AGH and open a new session

```sh
AGNES_PROFILE=local-dev agh web
```

For a source checkout without an `agh` command, use `node packages/cli/dist/local/agnes.mjs` in its place, after the installation guide's one-time runtime build.

Leave the daemon running. In another terminal with the same workspace, profile and home:

```sh
AGNES_PROFILE=local-dev agh -p 'hi'
```

A fresh local-dev profile selects route `demo`, model `demo-model`. Replies are labeled as demo. The adapter returns a fixed teaching reply through the real session loop. Check `/admin/plugins` for hello-tool and the new session’s tool catalog for `plugin_hello_tool`. To exercise tool selection, configure a scripted route with tool-call replies or a real model; the optional author test below invokes the tool without a model.

In Web, create a new session using **Demo (local scripted reply, no API key)** and submit `hi`. This is a teaching model: configure a real model for reasoning and automatic tool selection. Existing explicit model configuration takes precedence.

## 3. Edit and try again

Edit `src/index.ts`. Keep `ctx.signal.throwIfAborted()` and pass its signal into asynchronous work. Use `toolError('message')` for expected business refusal, and release clients/subscriptions through `ctx.effect()`.

Check `/admin/plugins` for activation errors. Local discovery watches changes, but the daemon currently marks edits `restart-required` until generation reload is connected. Start/restart the daemon after placing or editing the folder, then create a new session. Running sessions keep their pinned plugin generation. See [local plugins](local-plugins.md) for these lifecycle limits.

## 4. Optional compilation and tests

To compile a starter or run its author tests, build the preview SDK declarations once from the checkout:

```sh
nice -n 10 pnpm exec tsc -b packages/plugin-runtime packages/protocol
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
