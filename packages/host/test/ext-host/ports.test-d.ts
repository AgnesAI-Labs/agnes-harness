import type { HookEngine, HookRegistry, ResourceRegistry, ToolRegistry, ToolSource } from '@agnes/core'
import type { ExtensionAPI, HookHandler, SlotFill } from '@agnes/extension-api'
import { expectTypeOf } from 'vitest'
import type { ToolPort } from '../../src/ext-host/api.js'
import type { KernelPorts, RegMeta } from '../../src/ext-host/ports.js'

expectTypeOf<ToolPort>().toEqualTypeOf<KernelPorts['tools']>()
expectTypeOf<RegMeta>().toEqualTypeOf<ToolSource>()
expectTypeOf<ToolRegistry>().toExtend<KernelPorts['tools']>()
expectTypeOf<HookEngine>().toExtend<KernelPorts['hooks']>()
expectTypeOf<HookRegistry>().toExtend<KernelPorts['hooks']>()
expectTypeOf<ResourceRegistry>().toExtend<KernelPorts['resources']>()

declare const ports: KernelPorts
declare const context: HookHandler<'context'>
declare const status: SlotFill<'status.line'>
declare const meta: RegMeta

// Compile-only fixtures: the assembler must not erase event/payload correlation.
ports.hooks.on('context', context, meta)
ports.slots.register('status.line', status, meta)
// @ts-expect-error context handlers cannot consume before_step payloads
ports.hooks.on('before_step', context, meta)
// @ts-expect-error status.line payload is not a notification payload
ports.slots.register('notification', status, meta)
// @ts-expect-error registration metadata accepts only the two defined trust tiers
ports.hooks.on('context', context, { source: 'fixture/ext', trust: 'untrusted' })
// @ts-expect-error extension event data must be JSON
ports.extEvents.append('x/fixture/ext/test', { callback() {} }, meta)

declare const api: ExtensionAPI
api.registerSlot('status.line', status)
// @ts-expect-error the author API must reject the same mismatched slot payload
api.registerSlot('notification', status)
// @ts-expect-error the author API must reject a mismatched hook handler
api.registerHook('before_step', context)
