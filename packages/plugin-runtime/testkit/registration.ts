import type { Context, Fiber } from '@agnes/cordis'
import type { ToolDef } from '@agnes/extension-api'
import type { RowOrigin } from '../src/row-origin.js'

/** Small dependency-inversion port: the Host implementation owns real registration semantics. */
export interface PluginTestRegistration {
  tools: ReadonlyMap<string, ToolDef>
  install(root: Context, origins: { lookup(fiber: Fiber): Readonly<RowOrigin> | undefined }): void
  assertLoaded(): void
}
