# Your first plugin in five minutes

English | [简体中文](quickstart.zh-CN.md)

[Author kit](README.md) · [Testing guide](testing.md)

Start with a tool that echoes a message. You need Node.js 24.10 or later and an installed source checkout following [installation](../guide/install.md). This author test needs no model account, native build or network service.

## 1. Prepare the preview SDK

From the AGH checkout, install dependencies once and build the SDK declarations:

```sh
pnpm install --frozen-lockfile
nice -n 10 pnpm exec tsc -b packages/plugin-runtime packages/protocol
```

AGH packages are not yet publicly released on npm in this preview. The next step uses local SDK links. Once matching packages are published, use `npm install` inside the generated package instead of the local-link step.

## 2. Create an independent package

From the same checkout:

```sh
node templates/create-agh-plugin.mjs tool hello-tool ../hello-tool
node templates/link-local.mjs ../hello-tool
npm --prefix ../hello-tool run build
npm --prefix ../hello-tool test
```

The scaffolder refuses existing destinations and accepts scoped names such as `@acme/hello-tool`. It copies sources without running installation scripts. The preview linker requires a fresh package directory; it supplies built declarations and source runtime links without editing package imports.

Expect one passing test: real Host registration, invocation of `plugin_hello_tool`, invalid input/cancellation refusal, and tool removal on unload. The package lives outside the workspace and contains no `workspace:` dependency or repository-relative import.

## 3. Change the business logic

Open the generated `src/index.ts`. `parameters` infers `message` as a string. `result` requires a matching successful `structured` value. Replace the echo logic, preserving concise model-facing `content`.

Use `toolError('message')` for expected business refusal; let unexpected faults throw. Call `ctx.signal.throwIfAborted()` and pass `ctx.signal` into asynchronous operations. Bind persistent clients/subscriptions to `ctx.effect()` and release per-call resources in `finally`.

The starter is read-only, closed-world and safe to replay. Change these declarations when adding file writes, remote calls or other effects. Rebuild and rerun the package test after editing.

## 4. Run it in AGH

Follow [plugin management](../guide/packages.md) to install the built directory, review trust information and enable `main`. In a new session with a configured model, ask:

> Call plugin_hello_tool with message hello.

Expect `{"message":"hello"}` in the tool record. Inspect that record to verify a real tool call; a matching plain-text answer alone does not establish use of the plugin.

For a sidebar choose `tool-with-panel`; see [plugin kinds](README.md) for other starters. Its descriptor declares `ui:sidebar`, and its label renders through the separate browser lifecycle.
