import { expectTypeOf, it } from 'vitest'
import type {
  DefaultLoopConvenience,
  GenericLoopFactory,
  GenericLoopPorts,
  LoopContext,
  LoopFactory,
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
