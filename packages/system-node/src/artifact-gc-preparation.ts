import { createHash } from 'node:crypto'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { isProxy } from 'node:util/types'

/** Node-owned primitives used by Core's platform-neutral artifact GC attestation. */
export const nodeArtifactGcPreparationRuntime = Object.freeze({
  isProxy,
  canonicalDataDir(value: string): string | undefined {
    if (!isAbsolute(value)) return undefined
    const canonical = resolve(value)
    return canonical === value && canonical !== parse(canonical).root ? canonical : undefined
  },
  rootRelativePath(dataDir: string, path: string): string | undefined {
    const candidate = relative(dataDir, path)
    if (!candidate || candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate))
      return undefined
    return candidate.split(sep).join('/')
  },
  sha256Utf8(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  },
})
