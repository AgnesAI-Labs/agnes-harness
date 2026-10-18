# Independent browser runtime

Built-in, installed but disabled on first provisioning. Enable it in Settings → Plugin management,
then start a new conversation: the same switch supplies browser tools and the right-side Browser panel.
The enabled/disabled choice survives restarts. Existing installations retain their current choice;
older conversations retain their pinned tool versions. CLI/headless use does not require opening the UI.
No process or download starts until `browser_open`. No separate viewer installation is required.
The legacy `@agnes/browser-ui` remains compatible; this plugin wins panel selection to avoid duplicates.

Uses pinned agent-browser 0.39.1 native binaries (Apache-2.0) and Chrome for Testing's official
chrome-headless-shell 155.0.8059.84 on every platform. The first `browser_open` downloads the fixed vendor
archive through Host-managed system curl/tar into `~/.agent-browser/agh-headless`; this requires network
access and permission to write the cache. Interrupted installs are removed, and only a completed matching
installation is reused. Personal browser profiles, cookies, extensions and settings are not imported.
macOS Intel/Apple Silicon and Windows x64 are supported; Windows ARM uses upstream's x64 emulation.
Linux requires Chrome's OS dependencies. Missing process support or sandbox access fails explicitly.
Launches use the authorized session cwd and the existing Host policy. Restricted workspace
policies may deny the temporary profile or downloaded browser cache; declarations do not bypass that policy.
AGH's Windows backend has no restricted-token sandbox: its Job Object owns cleanup, not file/network
isolation. Mac's Seatbelt remains separate from Chrome's own sandbox, which stays enabled on both systems.
The dedicated headless binary avoids full Chrome's desktop/IME startup path. It is a real Chromium engine,
but full Chrome features such as extension UI are outside this plugin's contract.

`browser_open`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_press`, `browser_scroll`,
`browser_navigate`, `browser_tabs`, `browser_tab`, `browser_screenshot`, `browser_close` operate only
the current Host-bound session/lane. Start a generated project using existing shell background jobs,
then open its HTTP localhost URL and inspect it. The existing deliverables plugin still renders immutable files.

Each browser uses a private temporary profile, a private daemon endpoint and a Host-owned process tree.
No profile import, user-selected CDP endpoint, OS mouse control, arbitrary CLI arguments or executable override
is exposed. Commands use structured JSON, so text such as `--cdp` remains page data. Closing a browser
closes its process handle, never a discovered PID. Page content remains untrusted.
The Host owns the agent-browser daemon process tree; agent-browser launches only the specified Chrome for Testing
headless executable with AGH's private profile. The production path keeps Chrome's sandbox enabled and has no automatic
`--no-sandbox` fallback. Environments that cannot start sandboxed Chrome report an error.

The managed resource shares the current profile runtime with session tools. A profile query checks
authenticated session read access before issuing a one-use, actor-bound, 30-second viewer ticket.
The outbound-only stream uses AGH's same-origin authenticated stream gateway. It exposes no private ports
or browser command channel. Only the main lane is shown. The viewer renews its read authority regularly.
At most four session browsers and three viewers per browser are allowed. Idle daemons stop after 15 minutes;
session shutdown and plugin removal close owned processes. Viewing alone does not create a browser.

Build native payloads with `prepareBrowserRuntime` in `packages/cli/tools/browser-runtime.ts`.
Production and source Web builds invoke this automatically. No personal Chrome installation is required.
Each build includes only its target OS/architecture's agent-browser executable, using the same selection
as the runtime (including x64 on Windows ARM). Rebuilding removes other platform executables from the
build output, so plugin integrity reads do not repeatedly scan unused native payloads. Existing installed
packages and retained session snapshots are still managed by the normal package lifecycle.
