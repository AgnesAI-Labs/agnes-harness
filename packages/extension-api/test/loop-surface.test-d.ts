import { expectTypeOf, it } from 'vitest'
import type {
  DefaultLoopConvenience,
  GenericLoopFactory,
  GenericLoopPorts,
  LoopContext,
  LoopFactory,
  LoopToolCallOptions,
  LoopToolMeta,
  LoopTurnView,
} from '../src/index.js'

it('splits the generic ports from the default-loop convenience edges', () => {
  expectTypeOf<LoopContext>().toExtend<GenericLoopPorts>()
  expectTypeOf<LoopContext>().toExtend<DefaultLoopConvenience>()
  expectTypeOf<GenericLoopFactory>().toExtend<LoopFactory>()
  expectTypeOf<GenericLoopPorts['turn']>().not.toHaveProperty('continuation')
  expectTypeOf<GenericLoopPorts['model']>().not.toHaveProperty('respond')
  expectTypeOf<GenericLoopPorts['tools']>().not.toHaveProperty('drain')
  expectTypeOf<GenericLoopPorts['wait']>().not.toHaveProperty('poll')
  expectTypeOf<GenericLoopPorts['model']>().toHaveProperty('stream')
  expectTypeOf<GenericLoopPorts['tools']>().toHaveProperty('execute')
  expectTypeOf<LoopContext['turn']>().toHaveProperty('continuation')
})

it('takes an optional announce option on execute and batch', () => {
  type Tools = GenericLoopPorts['tools']
  expectTypeOf<Tools['execute']>().parameter(2).toEqualTypeOf<LoopToolCallOptions | undefined>()
  expectTypeOf<Tools['batch']>().parameter(2).toEqualTypeOf<LoopToolCallOptions | undefined>()
  expectTypeOf<NonNullable<LoopToolCallOptions['announce']>>().toEqualTypeOf<
    true | { readonly content: Array<{ type: 'text'; text: string } | { type: 'thinking'; text: string }> }
  >()
  // An existing two-argument implementation still fits the port.
  const execute: Tools['execute'] = async (_call, _signal) => ({ content: [] })
  expectTypeOf(execute).toBeFunction()
})

it('gives the turn view optional tool facts beside an unchanged tool list', () => {
  expectTypeOf<LoopTurnView['toolMeta']>().toEqualTypeOf<Readonly<Record<string, LoopToolMeta>> | undefined>()
  expectTypeOf<LoopTurnView['disclosedTools']>().toEqualTypeOf<readonly string[] | undefined>()
  expectTypeOf<LoopToolMeta>().toEqualTypeOf<{
    readonly isReadOnly: boolean
    readonly isDestructive: boolean
    readonly isOpenWorld: boolean
    readonly offered: boolean
  }>()
  expectTypeOf<keyof LoopTurnView['tools'][number]>().toEqualTypeOf<'name' | 'description' | 'parameters'>()
})
