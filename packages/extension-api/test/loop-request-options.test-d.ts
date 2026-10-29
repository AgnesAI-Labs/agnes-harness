import { expectTypeOf, it } from 'vitest'
import type { GenericLoopPorts, LoopRequestOptions, LoopTailNote } from '../src/index.js'

it('takes an optional tail note on a prepared loop request', () => {
  expectTypeOf<Parameters<GenericLoopPorts['prepareRequest']>[0]>().toEqualTypeOf<
    LoopRequestOptions | undefined
  >()
  expectTypeOf<LoopRequestOptions['tailNote']>().toEqualTypeOf<LoopTailNote | undefined>()
  expectTypeOf<LoopTailNote>().toEqualTypeOf<{ readonly text: string; readonly commit?: boolean }>()
  expectTypeOf<{ tailNote: { text: string } }>().toExtend<LoopRequestOptions>()
  expectTypeOf<{ tailNote: { commit: true } }>().not.toExtend<LoopRequestOptions>()
})
