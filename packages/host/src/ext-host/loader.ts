import { basename, dirname, join } from 'node:path'
import * as extensionApi from '@agnes/extension-api'
import * as protocol from '@agnes/protocol'
import * as typebox from '@sinclair/typebox'
import * as typeboxValue from '@sinclair/typebox/value'
import { createJiti } from 'jiti'
import { HostError } from '../errors.js'
import { resolveEntry } from './manifest.js'

export function runtimeForm(): 'sea' | 'bundled' | 'source' {
  if (process.getBuiltinModule('node:sea').isSea()) return 'sea'
  return import.meta.url.endsWith('.ts') ? 'source' : 'bundled'
}

/**
 * Candidate loader: forces the entry through jiti and shares actual host namespaces.
 * The pinned pnpm patch propagates forceTranspile through JS/TS/CJS graphs and refreshes JSON.
 * This is the production candidate importer; ordinary boot keeps its established importer. jiti's
 * unpatched moduleCache option alone does not clear Node's ESM module cache.
 */
export function createLoader(opts: { cacheDir: string; hostRoot: string; agnesVersion: string }): {
  import(entryFile: string): Promise<Record<string, unknown>>
} {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(opts.agnesVersion))
    throw new HostError('E_EXT_LOAD', 'invalid loader cache version')
  const jiti = createJiti(join(opts.hostRoot, 'package.json'), {
    moduleCache: false,
    fsCache: join(opts.cacheDir, 'jiti', opts.agnesVersion),
    virtualModules: {
      '@agnes/extension-api': extensionApi,
      '@agnes/protocol': protocol,
      '@sinclair/typebox': typebox,
      '@sinclair/typebox/value': typeboxValue,
    },
    tryNative: false,
    forceTranspile: true,
    interopDefault: true,
    debug: false,
    tsconfigPaths: false,
  })
  return {
    async import(entryFile) {
      const filename = resolveEntry(dirname(entryFile), basename(entryFile))
      try {
        const result: unknown = await jiti.import(filename)
        if (result === null || typeof result !== 'object') throw new Error('invalid module namespace')
        return result as Record<string, unknown>
      } catch {
        // Extension source and thrown values may contain credentials; never forward them.
        throw new HostError('E_EXT_LOAD', 'extension module evaluation failed')
      }
    },
  }
}
