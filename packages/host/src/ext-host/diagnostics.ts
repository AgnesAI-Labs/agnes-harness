export type LoadStage = 'package' | 'manifest' | 'identity' | 'entry' | 'import' | 'export' | 'factory'
const messages: Record<LoadStage, string> = {
  package: 'invalid bundled extension declaration',
  manifest: 'invalid extension manifest',
  identity: 'second extension claims this id',
  entry: 'extension entry cannot be resolved within its directory',
  import: 'extension module evaluation failed',
  export: 'extension module has no default export',
  factory: 'extension factory failed',
}
const codes = new Set([
  'E_EXT_LOAD',
  'E_EXT_ISOLATION_UNAVAILABLE',
  'E_API_RANGE',
  'E_CEILING_EXCEEDED',
  'E_LEASE_EXPIRED',
  'E_CAPABILITY_UNDECLARED',
  'E_TOOLDEF_META',
  'E_REGISTRY_DUPLICATE',
])

export function loadError(error: unknown, stage: LoadStage): { code: string; message: string } {
  let code = 'E_EXT_LOAD'
  try {
    if (error && typeof error === 'object') {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
      if (
        descriptor &&
        'value' in descriptor &&
        typeof descriptor.value === 'string' &&
        codes.has(descriptor.value)
      )
        code = descriptor.value
    }
  } catch {
    /* Proxy traps are not trusted diagnostics. */
  }
  return {
    code,
    message:
      code === 'E_CAPABILITY_UNDECLARED'
        ? 'extension capability not declared'
        : code === 'E_CEILING_EXCEEDED'
          ? 'extension exceeds capability ceiling'
          : messages[stage],
  }
}

export function diagnostic(call: () => unknown): void {
  try {
    void Promise.resolve(call()).catch(() => undefined)
  } catch {
    /* Diagnostics cannot abort loading or cleanup. */
  }
}
