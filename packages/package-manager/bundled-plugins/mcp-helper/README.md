# Agnes MCP Helper

Official bundled plugin. New local profiles and existing profiles adopting default helpers install, trust and enable missing shipped helpers once, offline. Already installed packages retain their version, trust and enablement state. Later starts and upgrades preserve user disable/removal choices. Removing this helper does not delete resources it previously connected.

Provides `mcp_manage`: prepare, commit, status, cancel and list. The host validates every request, binds it to the active main conversation and obtains native approval before registration, trust and enabling. Submitted connections take effect at a turn boundary. This plugin cannot override deployment policy or configure other clients.

`prepare` requires `definition`; `commit`, `status` and `cancel` require the returned `proposalId`; `list` requires only `action`. `prepared` is a preview, and `registered`/`submitted` are pending connection. End the turn after submission and query status later. `ready` confirms backend connection; the current turn's tool catalog determines which tools are callable. Review changed, blocked or disabled resources in Settings; report failure, cancellation or denial without automatically retrying or bypassing the decision.

Supports credential-free stdio, HTTP and SSE definitions. Configure credentials through existing AGH settings/CLI SecretRef flows. Application add-ons and application connectivity require separate verification. No automatic scripts, external client imports or OAuth session support.

Apache-2.0; see LICENSE.
