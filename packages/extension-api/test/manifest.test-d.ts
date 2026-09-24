import type { Capabilities, ExtensionManifest as ProtocolManifest } from '@agnes/protocol'
import { expectTypeOf } from 'vitest'
import type { ExtensionCapabilities, ExtensionManifest, ResourceEntry, ResourceKind } from '../src/index.js'

expectTypeOf<ExtensionManifest>().toEqualTypeOf<ProtocolManifest>()
expectTypeOf<ExtensionCapabilities>().toEqualTypeOf<Capabilities>()
expectTypeOf<ResourceEntry['kind']>().toEqualTypeOf<ResourceKind>()
