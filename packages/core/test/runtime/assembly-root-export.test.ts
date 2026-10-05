import * as Core from '@agnes/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { defaultLoopStateCodec } from '../../src/runtime/loop/default-state.js'
import { createContextFactory } from '../../src/runtime/providers/context.js'
import { createDefaultLoopFactory } from '../../src/runtime/providers/loop.js'
import { createProjectionProvider } from '../../src/runtime/providers/projection.js'
import { createDefaultToolsFactory } from '../../src/runtime/providers/tools.js'
import { createTextStatisticsTool } from '../../src/runtime/tools/definitions.js'

describe('public default assembly exports', () => {
  it('publishes the existing factories and fixed configuration sources', () => {
    expect(Core.createContextFactory).toBe(createContextFactory)
    expect(Core.createDefaultToolsFactory).toBe(createDefaultToolsFactory)
    expect(Core.createDefaultLoopFactory).toBe(createDefaultLoopFactory)
    expect(Core.defaultLoopStateCodec).toBe(defaultLoopStateCodec)
    expect(Core.createTextStatisticsTool).toBe(createTextStatisticsTool)
    expect(Core.createProjectionProvider).toBe(createProjectionProvider)
  })

  it('exports the existing deployment types for root-only assembly', () => {
    expectTypeOf<Core.ToolsDeployment>().toEqualTypeOf<
      import('../../src/runtime/providers/tools.js').ToolsDeployment
    >()
    expectTypeOf<Core.ContextDeployment>().toEqualTypeOf<
      import('../../src/runtime/providers/context.js').ContextDeployment
    >()
    expectTypeOf<Core.ContextFactoryOptions>().toEqualTypeOf<
      import('../../src/runtime/providers/context.js').ContextFactoryOptions
    >()
    expectTypeOf<Core.ContextSourceSnapshot>().toEqualTypeOf<
      import('../../src/runtime/providers/context.js').ContextSourceSnapshot
    >()
    expectTypeOf<Core.DefaultLoopInputs>().toEqualTypeOf<
      import('../../src/runtime/providers/loop.js').DefaultLoopInputs
    >()
    expectTypeOf<Core.DefaultLoopSource>().toEqualTypeOf<
      import('../../src/runtime/providers/loop.js').DefaultLoopSource
    >()
    expectTypeOf<Core.ProjectionProviderOptions>().toEqualTypeOf<
      import('../../src/runtime/providers/projection.js').ProjectionProviderOptions
    >()
    expectTypeOf<Core.ProjectionProvider>().toEqualTypeOf<
      import('../../src/runtime/providers/projection.js').ProjectionProvider
    >()
    expectTypeOf<Core.DomainCommandStorage>().toEqualTypeOf<
      import('../../src/runtime/projection/commands.js').DomainCommandStorage
    >()
  })
})
