# Agnes MCP Helper

Official bundled plugin. New local profiles and existing profiles adopting default helpers install, trust and enable missing shipped helpers once, offline. Already installed packages retain their version, trust and enablement state. Later starts and upgrades preserve user disable/removal choices. Removing this helper does not delete resources it previously connected.

Provides `mcp_manage`: prepare, commit, status, cancel and list. The host validates every request, binds it to the active main conversation and obtains native approval before registration, trust and enabling. Submitted connections take effect at a turn boundary. This plugin cannot override deployment policy or configure other clients.

Supports credential-free stdio, HTTP and SSE definitions. Configure credentials through existing AGH settings/CLI SecretRef flows. Application add-ons and application connectivity require separate verification. No automatic scripts, external client imports or OAuth session support.

Apache-2.0; see LICENSE.
