import type { LoopFactory } from '@agnes/extension-api'

/** Preserve a factory's inferred shape; scheduling and registration remain Host-owned. */
export function defineLoop<L extends LoopFactory>(factory: L): L {
  return factory
}
