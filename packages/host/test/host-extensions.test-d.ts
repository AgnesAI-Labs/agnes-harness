import { expectTypeOf } from 'vitest'
import type { ExtensionStatus } from '../src/ext-host/index.js'
import type { Host } from '../src/host.js'

// Host.extensions() really returns the managed ext host's own ExtensionStatus, not a cast that
// merely reuses the legacy ExtStatus's runtime shape under a new name - the two are structurally
// different (the legacy shape carried per-source tool-name lists; the managed host's does not, see
// Kernel.registrations()'s own comment on why tools are excluded from that aggregation).
expectTypeOf<ReturnType<Host['extensions']>>().toEqualTypeOf<ExtensionStatus[]>()

declare const status: ExtensionStatus
status.id
status.package
status.trust
status.version
status.loaded
// @ts-expect-error ExtensionStatus carries no `registered` tool-name list - only the legacy
// ExtStatus did, and doctor-extensions.ts had to be rewritten off it for exactly this reason.
status.registered
// @ts-expect-error ExtensionStatus carries no `declared` tool-name list either, same reason.
status.declared
// A builtin a plugin row has taken over names its replacement; everything else leaves it out.
expectTypeOf(status.replacedBy).toEqualTypeOf<string | undefined>()
