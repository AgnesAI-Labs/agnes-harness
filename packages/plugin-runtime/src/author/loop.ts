import { type LoopFactory, loopKind } from '@agnes/extension-api'
import { defineProvider } from './providers.js'

/** Preserve a factory's inferred shape; scheduling and registration remain Host-owned. */
export function defineLoop<L extends LoopFactory>(factory: L): L {
  return defineProvider(loopKind, factory)
}
