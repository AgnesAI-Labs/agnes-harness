# Your first Loop in four steps

English | [简体中文](first-loop.zh-CN.md)

[Author kit](README.md) · [First tool](quickstart.md) · [Workflows](workflow-loops.md)

Use Node.js 24.10+ and a [built source checkout](../guide/install.md). A Loop plugin supplies a way to run tasks; it needs no Bundle, agent or application. These four steps use the keyless Demo without a real model.

## 1. Create a local Loop

```sh
export AGH_SOURCE="/absolute/path/to/agnes-harness"
export AGH_HOME="$(mktemp -d /tmp/agh-loop.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
AGH_WORKSPACE="$(mktemp -d /tmp/agh-loop-workspace.XXXXXX)"
cd "$AGH_WORKSPACE"
mkdir -p .agh/plugins
node "$AGH_SOURCE/templates/create-agh-plugin.mjs" loop hello-loop .agh/plugins/hello-loop --local
```

## 2. Start and inspect registration

Keep the same workspace, home and profile. After `dev` activates the plugin, `tools` checks the shared backend; package status should include ready `hello-loop` version `0.1.0`. Step 3 verifies that the selected Loop actually runs.

```sh
node "$AGH_SOURCE/agnes.mjs" dev .agh/plugins/hello-loop --profile local-dev
node "$AGH_SOURCE/agnes.mjs" tools
node "$AGH_SOURCE/agnes.mjs" package status --json
```

## 3. Select the Loop explicitly

```sh
node "$AGH_SOURCE/agnes.mjs" --new --loop hello-loop@0.1.0 -p 'hello'
```

Expect a labeled local Demo reply. `--loop` binds the execution choice at new-session creation without creating an agent. The template uses `defineWorkflowLoop` for checkpoints, cancellation and recovery; added effects still need declared capabilities and tool authorization.

## 4. Edit and run again

Edit the stage prompt in `.agh/plugins/hello-loop/src/index.ts`. Change the Loop version there and the package version in `package.json` to `0.1.1`, then activate and select the new version below. Provider definitions are versioned; existing sessions retain their pinned generation.

```sh
node "$AGH_SOURCE/agnes.mjs" dev .agh/plugins/hello-loop --profile local-dev
node "$AGH_SOURCE/agnes.mjs" --new --loop hello-loop@0.1.1 -p 'hello again'
node "$AGH_SOURCE/agnes.mjs" daemon stop
```

To offer a launchable agent later, add a [Bundle](bundles-and-profiles.md) with an explicit `launch.preset`. Optional compilation and author tests use [tool tutorial step 5](quickstart.md#5-optional-compilation-and-tests).
