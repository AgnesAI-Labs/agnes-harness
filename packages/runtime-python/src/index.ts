import type { RuntimeFactory, RuntimesExport } from '@agnes/code/runtime'

/**
 * Spike-gated seam only. The Python backend is intentionally unavailable until the A/B spike
 * demonstrates that an Agnes-native implementation can satisfy the shared CodeRuntime contract.
 */
const python: RuntimeFactory = async () => {
  throw new Error(
    'E_PRESET_UNSUPPORTED: the python code runtime is not implemented yet (spike-gated; see packages/runtime-python/README.md)',
  )
}

export const runtimes: RuntimesExport = { python }
