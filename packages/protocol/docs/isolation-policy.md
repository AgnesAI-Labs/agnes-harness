# Extension isolation policy

`validateExtensionIsolationPolicy` validates and copies a bounded policy without executing getters.
It accepts exact Extension IDs, modes `off | preferred | required`, and an optional backend from
`auto | seatbelt | bwrap | restricted-token`. A backend name does not claim platform support.

`validateExtensionIsolationRequest` is the workspace subset: only an `extensions` map with
`preferred | required` values. It rejects backend selection, defaults, wildcards and `off`.
RuntimeProfileManifest, ResolvedProfile and ManagedPolicy carry optional policies; ProfileFragment
carries the request. Missing fields preserve old documents. Old strict schemas reject new fields.

Host merges each ID by maximum mode, hashes the effective policy and checks manifest runtime support
before factory evaluation. `E_EXT_ISOLATION_UNAVAILABLE` is a Host error code; unsupported required
isolation cannot fall back. R1 owns generic runner support, not these data definitions.
