import { realpathSync } from 'node:fs'

const windows = process.platform === 'win32' // guards-allow-platform: shared filesystem leaf.

/** Resolve existing paths only. Use this on BOTH sides of filesystem identity/containment checks. */
export function nativeRealpathSync(path: string): string {
  // No JS fallback: it preserves aliases (subst/mapped roots, 8.3 names) that native expands.
  // Keep the physical root returned by the OS; restoring the caller's drive would hide escapes.
  // ENOENT and other errors propagate unchanged; callers own missing-path/refusal policy.
  const real = realpathSync.native(path)
  if (!windows) return real
  // libuv normally strips the namespace prefix. Normalize it explicitly for comparisons, including
  // UNC paths; Node filesystem APIs still support long paths without the prefix. Never lowercase
  // the whole path: Windows also supports case-sensitive directories.
  const plain = real.startsWith('\\\\?\\UNC\\')
    ? `\\\\${real.slice(8)}`
    : /^\\\\\?\\[a-z]:\\/i.test(real)
      ? real.slice(4)
      : real
  return plain.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
}
