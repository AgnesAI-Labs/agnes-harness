# Your first Loop in four steps

English | [简体中文](first-loop.zh-CN.md)

[Author kit](README.md) · [First tool](quickstart.md) · [Workflows](workflow-loops.md)

Use Node.js 24.10+ and a [built source checkout](../guide/install.md). A Loop plugin supplies a way to run tasks; it needs no Bundle, agent or application. These four steps use the keyless Demo without a real model.

<a id="1-create-a-local-loop"></a>

## Preparation (outside the step count)

```sh
export AGH_SOURCE="/absolute/path/to/agnes-harness"
export AGH_HOME="$(mktemp -d /tmp/agh-loop.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
AGH_WORKSPACE="$(mktemp -d /tmp/agh-loop-workspace.XXXXXX)"
cd "$AGH_WORKSPACE"
```

## 1. Create the plugins folder

```sh
mkdir -p .agh/plugins
```

## 2. Scaffold the Loop

```sh
node "$AGH_SOURCE/templates/create-agh-plugin.mjs" loop hello-loop .agh/plugins/hello-loop --local
```

<a id="2-start-and-inspect-registration"></a>

## 3. Activate the plugin

Keep the same workspace, home and profile; `dev` starts the daemon when needed.

```sh
node "$AGH_SOURCE/agnes.mjs" dev .agh/plugins/hello-loop --profile local-dev
```

<a id="3-select-the-loop-explicitly"></a>

## 4. Select the Loop explicitly

```sh
node "$AGH_SOURCE/agnes.mjs" --new --loop hello-loop@0.1.0 -p 'hello'
```

Expect a labeled local Demo reply. `--loop` binds the execution choice at new-session creation without creating an agent. The template uses `defineWorkflowLoop` for checkpoints, cancellation and recovery; added effects still need declared capabilities and tool authorization.

<a id="4-inspect-the-result-and-clean-up"></a>

## Optional verification (after first success)

Check the Demo-labeled `answer` from step 4 and retain the session identifier printed by the terminal. These checks are not required for first success. Keep the temporary home to inspect its records later; only remove temporary directories you created.

```sh
node "$AGH_SOURCE/agnes.mjs" tools
node "$AGH_SOURCE/agnes.mjs" package status --json
node "$AGH_SOURCE/agnes.mjs" sessions --json
```

To change business stages, read [Workflows](workflow-loops.md) and increment the Loop version when checkpoint meaning changes. To offer a launchable agent, add a [Bundle](bundles-and-profiles.md) with an explicit `launch.preset`. Optional compilation and author tests use [tool tutorial’s optional compilation section](quickstart.md#5-optional-compilation-and-tests).

## Clean up

```sh
node "$AGH_SOURCE/agnes.mjs" daemon stop
```
