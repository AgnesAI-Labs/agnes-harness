import type { JsonValue } from '@agnes/protocol'
import type { ToolResult } from './tool.js'

export interface ToolRuntimeCall {
  id: string
  name: string
  args: JsonValue
  /** Host-resolved metadata; omission is exclusive. */
  concurrencySafe: boolean
}

export interface ToolSchedulingPolicy {
  maxParallel: number
}

/** Core supplies this port: it owns authorization, approval, effects and result persistence. */
export interface ToolRuntimeExecution {
  dispatch(call: ToolRuntimeCall, signal: AbortSignal): Promise<ToolResult>
}

/** One session-owned instance. Cancellation must drain started calls before returning. */
export interface ToolRuntime {
  execute(call: ToolRuntimeCall, execution: ToolRuntimeExecution, signal: AbortSignal): Promise<ToolResult>
  batch(
    calls: readonly ToolRuntimeCall[],
    execution: ToolRuntimeExecution,
    signal: AbortSignal,
  ): Promise<readonly ToolResult[]>
  cancel(): void | Promise<void>
  dispose(): void | Promise<void>
}

export interface ToolRuntimeProvider {
  id: string
  version: string
  create(options: ToolSchedulingPolicy): ToolRuntime
}

export interface ToolRuntimeCatalogEntry {
  id: string
  version: string
  sourcePackage: string
}

export interface ToolRuntimeRegistryPort {
  register(sourcePackage: string, provider: ToolRuntimeProvider): () => void
  resolve(id: string): ToolRuntimeProvider
  catalog(): readonly ToolRuntimeCatalogEntry[]
}

export interface ToolRuntimePluginContext {
  toolRuntimes: ToolRuntimeRegistryPort
  effect(callback: () => () => void): unknown
}
export function registerToolRuntimePlugin(
  ctx: ToolRuntimePluginContext,
  sourcePackage: string,
  provider: ToolRuntimeProvider,
): void {
  ctx.effect(() => ctx.toolRuntimes.register(sourcePackage, provider))
}
