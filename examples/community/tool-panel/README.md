# @community/tool-panel

A standalone package scaffolded from tool-with-panel. See the [external author
setup](../README.md) to install preview tarballs, build, and run the two small test
files. It uses the production registration bridge exposed by the public plugin
testkit; no daemon or model is needed for those tests.

plugin_tool_panel takes { "message": "  Agnes  " } and returns
{ "message": "Echo: Agnes", "characters": 5 }. Both input and successful
structured output have TypeBox schemas. Whitespace-only messages are business
errors; invalid arguments, cancellation, and invalid config remain exceptions.
characters counts Unicode code points in the trimmed input. There is no I/O.

The row's config.prefix defaults to "Echo: ". Change it in package.json
before building/installing, or use a supported row-config editor in your Host.
It must be a string of at most 64 characters. The tests use "Hello: ".

## Install and try

Start an isolated AGH instance with the packed @agnes/harness executable. In
Settings → Plugins, inspect/install file:/absolute/path/to/tool-panel, review
the package and enable it. Use an absolute source path when the daemon was
started elsewhere. See [plugin management](../../../docs/guide/packages.md).

Create a new session and explicitly ask it to call plugin_tool_panel with
{"message":"  Agnes  "}. Inspect the structured result and the **Echo result**
panel in that tool's transcript card. The browser module uses the supported
tool.call.toolview slot, keyed to this tool, and displays the host's bounded
resultPreview and actual status. It renders untrusted result text as text.
React stays external so the host import map supplies its shared instance.
The public client descriptor contains only the panel label, never backend config.

The backend requires the Host's extension service. On a Host without that
injection the row cannot activate; inspect its missing-inject/dependency error
in Plugins. The author test separately demonstrates a descriptive error when
the callback is called without the service. This does not simulate a Host
activation or assert a fabricated active state.

## Cleanup

Disable and remove @community/tool-panel through plugin management. The
backend lifecycle effect unregisters the tool, and the browser effect removes
its slot. A new session must no longer discover the tool or load its panel.
Existing sessions may retain bindings according to the Host's generation rules.
The tests cover registration removal and panel cleanup; real browser loading and
session activation require this manual check.
