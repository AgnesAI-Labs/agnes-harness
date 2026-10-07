import type { ModelAdapter } from '@agnes/extension-api'

/** Infer a structural adapter declaration; credentials and lifecycle stay with the Host. */
export function defineModelAdapter<A extends ModelAdapter>(adapter: A): A {
  return adapter
}
