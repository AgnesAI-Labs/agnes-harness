# Quickstart: complete your first task

English | [简体中文](quickstart.zh-CN.md)

<a id="快速开始跑通你的第一个任务"></a>

[Documentation](../README.md) · Prerequisite: [Build AGH](install.md)

Configure a model, run a small task, and find the Web session from the CLI. Complete the [source build](install.md) first; use its isolated home setup for your first trial. Without a model account, start with the [local simulated-model demo](demo.md#run-locally-without-a-model-account).

<a id="第一次打开-web"></a>

## Open Web for the first time

```sh
node packages/cli/dist/local/agnes.mjs serve
```

The default address is `http://127.0.0.1:4177`; use the actual URL printed by your terminal. Local mode opens a normal URL. You do not need to copy a connection token from the address bar or paste daemon credentials into the page.

If no model is available, AGH opens Provider settings. Choose an account/provider, check the Base URL, enter the API key in the password field, test the connection, select a model from the returned catalog, and save. The page displays configuration status without reading saved plaintext keys back to the browser. Connection tests and conversations may contact the provider and incur charges. Use the [local demo](demo.md) if you do not have a model account.

You can choose Agnes AI, Kimi, Kimi Coding Plan, GLM, Qwen, DeepSeek, OpenAI, Anthropic, Google, OpenRouter, MiniMax, or xAI. Web lists Agnes AI first. Available models, routes, and capabilities come from the current catalog and account configuration; a provider's name alone does not establish tool, vision, or reasoning support. Test custom endpoints through the configuration service and select their models without disguising incompatible endpoints as a known model.

After saving, read the activation message. `new-sessions` means the setting applies to new sessions; existing sessions keep their selections. If a restart is required, finish any tasks you need to preserve, run `daemon stop` with the same home/profile, then run `serve` again. On connection errors, check that the home/profile still identifies the same instance.

Create a new task, confirm its working directory, and send:

> Read this project and describe its main directories and their purpose. Do not modify files or run installation commands.

This expresses your intent; approvals and policy determine the execution boundary. Read the [security guide](security.md) before granting execution permissions.

**Check the result:** The page should show a response for the turn. If the model used a tool, expand its record and inspect the name, arguments, and result. Confirm that the task finishes or enters an explicit waiting state. Return to the session list and reopen the task to confirm its history is readable. Keep any error code and follow [troubleshooting](troubleshooting.md) if needed.

<a id="第一次运行-cli"></a>

## Run the CLI for the first time

`serve` occupies the current terminal. Open another terminal in the same source directory. If you set `AGH_HOME` or `AGNES_PROFILE`, set exactly the same values there. Do not run `mktemp` again: that would create a different instance for the CLI. With no overrides, both clients use the default home/profile.

Configure interactively:

```sh
node packages/cli/dist/local/agnes.mjs config
```

Once configured, run the following from the repository root. `AGH_ENTRY` saves the absolute entry path so you can continue using it after changing to your own project directory:

```sh
AGH_ENTRY="$PWD/packages/cli/dist/local/agnes.mjs"
node "$AGH_ENTRY" -p "Summarize this project without modifying files"
node "$AGH_ENTRY" sessions --json
node "$AGH_ENTRY"
```

The last command starts the TUI in a real TTY; redirected stdin or stdout selects print mode. `config` and Web use the same Host configuration service. Do not copy old experimental scripts that write credentials into another product's home.

To select a model explicitly, obtain its current route/model from Web or TUI `/model`:

```sh
node "$AGH_ENTRY" -p --model main=ROUTE/MODEL "Hello"
```

`ROUTE` is an actual route ID and may identify an account; it is not necessarily a provider brand. Unknown routes or models are rejected. There is no `--api-key` or legacy `--session` option.

<a id="确认共享与退出"></a>

## Confirm sharing and stop the instance

```sh
node "$AGH_ENTRY" daemon status
node "$AGH_ENTRY" sessions --json
```

With the same home/profile/dataDir, a session created in Web should appear in the CLI list. Closing the TUI or browser does not stop the shared daemon. To finish a trial, stop the Web terminal process, then run:

```sh
node "$AGH_ENTRY" daemon stop
```

Keeping the trial home lets you return to sessions later. It may contain conversation text and user input, so do not commit it.

<a id="接下来做什么"></a>

## Next steps

Add a [Skill](skills.md) to bring your team's methods into a task, start [plugin development](../develop/plugins.md) to connect business systems, or read [sessions and recovery](sessions.md) to continue existing work.

Implementation: [configuration controller](../../packages/host/src/configuration.ts), [provider registry](../../packages/cli/src/onboarding/provider-registry.ts), [Web model settings](../../packages/web/src/settings.ts), [CLI arguments](../../packages/cli/src/args.ts).
