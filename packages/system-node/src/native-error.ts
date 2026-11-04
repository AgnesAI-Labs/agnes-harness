/** Loader prose may include local paths; only a version identifier is safe diagnostic text. */
export function nativeLoadError(error: unknown): Error & { code: string; detail?: { reason: string } } {
  const version =
    error instanceof Error
      ? /\bGLIBC_(\d+\.\d+(?:\.\d+)?)\b[^\n]*not found/.exec(error.message)?.[1]
      : undefined
  return Object.assign(
    new Error(
      version
        ? `system-node native addon failed to load: GLIBC_${version} not found`
        : 'System module is missing or incompatible; rebuild the native artifact',
    ),
    {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
      ...(version ? { detail: { reason: 'native-glibc-incompatible' } } : {}),
    },
  )
}
