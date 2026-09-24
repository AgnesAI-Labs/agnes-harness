import type { CapabilityReport, PlatformFacts, PlatformView } from '@agnes/extension-api'
import type { PlatformSeam } from './seams.js'

/**
 * The read-only platform view an extension may see, copied field by field from the fitted seam.
 * Copied, not spread: the host's platform backend carries members the seam contract never promised
 * (os, snapshot, probes), and a spread would hand those to every extension as if they were API.
 * Optional fields are written only when present - exactOptionalPropertyTypes forbids an explicit
 * undefined, and a consumer comparing keys must see the same shape in-process and over JSON.
 */
export function platformFacts(seam: PlatformSeam): PlatformFacts {
  const fs = seam.fs()
  const terminal = seam.terminal()
  return Object.freeze({
    shell: seam.shell(),
    fs: Object.freeze({ caseSensitive: fs.caseSensitive, pathSep: fs.pathSep }),
    terminal: Object.freeze({
      color: terminal.color,
      ...(terminal.width !== undefined ? { width: terminal.width } : {}),
    }),
  })
}

/** Facts plus the live probe, for the two moments (tool, service) that may ask about a capability. */
export function platformView(seam: PlatformSeam): PlatformView {
  return Object.freeze({
    ...platformFacts(seam),
    capability(id: string): CapabilityReport {
      // Deliberately the raw seam, not SeamRuntime.capability() (effects/wrap.ts): that wrapper
      // memoizes its result per id in `this.caps` for the lifetime of the runtime, which is exactly
      // what this contract promises NOT to do - PlatformView.capability() is a live probe on every
      // call. (Contrast sandbox.enforcement() in tool-context.ts, which DOES go through
      // SeamRuntime.enforcement() for its fail-closed bound; SeamRuntime does not cache that one.)
      //
      // Bypassing SeamRuntime.capability() also means bypassing the fail-closed guard bundled with
      // it, so that guard is reimplemented here on its own: the public contract (common.ts) declares
      // capability(id: string) total over any string, with CapabilityReport.level including
      // 'unavailable' for exactly "don't know this one". The real host backends (platform-posix.ts,
      // platform-win32.ts) instead assertCapabilityId(id) and throw for any id outside their fixed
      // CAPABILITY_IDS list - unknown ids are expected input for a public API that accepts any
      // string, not exceptional, so a throw here must degrade rather than propagate into extension
      // code. This mirrors SeamRuntime.capability()'s own catch fallback shape (wrap.ts) but adds no
      // caching of its own.
      let report: ReturnType<PlatformSeam['capability']>
      try {
        report = seam.capability(id)
      } catch {
        return Object.freeze({ level: 'unavailable' as const, scope: Object.freeze([]), reason: 'threw' })
      }
      return Object.freeze({
        level: report.level,
        scope: Object.freeze([...report.scope]),
        ...(report.reason !== undefined ? { reason: report.reason } : {}),
      })
    },
  })
}
