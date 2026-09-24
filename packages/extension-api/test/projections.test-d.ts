import type { JsonValue } from '@agnes/protocol'
import { expectTypeOf, it } from 'vitest'
import type {
  ExtensionAPI,
  ProjectionDef,
  ProjectionEvent,
  ProjectionReader,
  ServiceContext,
  ServiceDef,
} from '../src/index.js'

it('keeps projection handlers synchronous and without a context', () => {
  expectTypeOf<Parameters<ProjectionDef['apply']>>().toEqualTypeOf<[Readonly<JsonValue>, ProjectionEvent]>()
  expectTypeOf<ReturnType<ProjectionDef['init']>>().toEqualTypeOf<JsonValue>()
  expectTypeOf<Parameters<ProjectionReader['readOwn']>>().toEqualTypeOf<[string]>()
  expectTypeOf<ProjectionReader>().not.toHaveProperty('list' as never)
})
it('keeps Service separate from session/model/UI and exposes both register methods', () => {
  expectTypeOf<ServiceContext>().not.toHaveProperty('session' as never)
  expectTypeOf<ServiceContext>().not.toHaveProperty('model' as never)
  expectTypeOf<ReturnType<ServiceDef['handler']>>().toEqualTypeOf<Promise<JsonValue>>()
  expectTypeOf<ExtensionAPI>().toHaveProperty('registerService')
  expectTypeOf<ExtensionAPI>().toHaveProperty('registerProjection')
})
