import { type ModelAdapter, modelAdapterKind } from '@agnes/extension-api'
import { defineProvider } from './providers.js'

/** Infer a structural adapter declaration; credentials and lifecycle stay with the Host. */
export function defineModelAdapter<A extends ModelAdapter>(adapter: A): A {
  return defineProvider(modelAdapterKind, adapter)
}
