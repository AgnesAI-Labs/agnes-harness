# Superagent

A bundled plugin that watches one GitHub repository, assesses requests under its policy, turns authorized ones into
tickets and works each ticket in its own session. It is installed and enabled by default, with a sidebar entry. Until
configured it waits for setup without listening to sources, starting tasks or calling models. Upgrades preserve existing
configuration and explicit disable or uninstall choices; profile capability ceilings still apply. Reinstall it from the
AGH Marketplace if you previously removed it. Default installation grants no external account or requester access.

The plugin runs one profile-managed service. Only this shipped payload, with bytes matching the release snapshot,
receives the platform's bundled-app grant: a private state directory, an owner-level local client and access to the
owner's channel instances. A copy installed from any other source does not start.

It publishes two bundles: `@agnes/superagent#router` for its main session and `@agnes/superagent#worker` for ticket
sessions. Its `orchestrator_*` tools are visible only in sessions that select one of them; the owner's other sessions are
unchanged.

The generated entry requires an in-process host compatible with Extension API 5.22. It is built from
`packages/superagent`; it is not a separate implementation. See NOTICE for the MIT-licensed material it contains.
