import { validatePreset } from '@agnes/protocol'

export type RunLimits = {
  wallMs: number
  maxOutputChars: number
  language: 'python' | 'typescript'
  maxParallelSubCalls: number
}

/** Configuration validity only. Host must separately check the renderer and actual runtime. */
export function readLimits(preset: Record<string, unknown>): RunLimits {
  const input = preset.code_runtime
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('E_PRESET_UNSUPPORTED: missing code_runtime configuration')
  const block = { ...input } as Record<string, unknown>
  if (!validatePreset({ name: 'code-limits', code_runtime: block }).ok)
    throw new Error('E_PRESET_UNSUPPORTED: invalid code_runtime configuration')
  const numeric = (key: string, fallback: number): number => {
    const value = block[key] === undefined ? fallback : block[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
      throw new Error('E_PRESET_UNSUPPORTED: invalid code_runtime limit')
    return value
  }
  return {
    language: block.language as RunLimits['language'],
    wallMs: numeric('cell_timeout_ms', 600000),
    maxOutputChars: numeric('max_output_chars', 65536),
    maxParallelSubCalls: numeric('max_parallel_sub_calls', 4),
  }
}
