# Judgment settings source

This private browser source package is bundled into the existing `@agnes/judgment` optional payload.
Users install one judgment package. The browser module uses only public React, web-client and web-ui
APIs and never imports the judgment runtime.

The settings section queries the read-only profile service `judgment.status`. Its descriptor must
allow that exact service and bind to the active judgment backend row. The response parser accepts
only the versioned enums, configuration fingerprint and bounded instance counters in `src/status.ts`.
It rejects extra fields, including private inputs or rule content. The configuration fingerprint
identifies the running instance configuration; it is not the host's persisted configuration revision.

The page clears statistics on refresh failure or contribution withdrawal. It has no browser storage,
session reads, configuration writes or model calls. Granted hook timeout remains unknown without
actual authorization evidence. Configuration changes retain the host's next-session behavior.
The settings link opens the existing judgment plugin detail, which contains its configuration tab.

`test/settings.test.tsx` renders the real React settings component through the public client testkit,
replacing only the profile caller. It verifies loading, refresh, refusal, malformed responses,
service allowlists and lifecycle withdrawal without an active session.
