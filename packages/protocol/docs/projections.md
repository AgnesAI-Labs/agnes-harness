# Extension Projection declarations

Generated from schema/projection.json by tools/gen-docs.ts. Do not edit by hand.

Capability: `name`, `inputEventTypes`, `maxStateBytes`.

Event types are exact and unique; wildcards are rejected. State and view are bounded to 262144 bytes. Manifest projection names must be distinct (validated by validateExtensionManifest).

Read results are available or unavailable. Unavailable results carry only a stable code and safe message. Owner and session are bound by Host, not supplied by Extension callers.
