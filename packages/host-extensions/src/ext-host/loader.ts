import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ProviderError } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import * as intelligentUiContract from '@agnes/intelligent-ui-contract'
import {
  checkPluginApiRanges,
  checkProvidedExternals,
  missingPluginModule,
  PluginModuleError,
} from '@agnes/plugin-runtime/provided-externals'
import * as protocol from '@agnes/protocol'
import { createJiti } from 'jiti'
import { localPluginVirtualModules } from '../local-plugin-loader.js'
import { resolveEntry } from './manifest.js'

/** Only resolver-produced diagnostics may cross the module-evaluation error boundary. */
export class PluginImportError extends HostError {
  constructor(failure: PluginModuleError) {
    super('E_EXT_LOAD', failure.message, { detail: { reason: failure.reason, module: failure.module } })
  }
}

export function runtimeForm(): 'sea' | 'bundled' | 'source' {
  if (process.getBuiltinModule('node:sea').isSea()) return 'sea'
  return import.meta.url.endsWith('.ts') ? 'source' : 'bundled'
}

/**
 * Plugin loader: forces the entry through jiti and shares actual host namespaces.
 * The pinned pnpm patch propagates forceTranspile through JS/TS/CJS graphs and refreshes JSON.
 * Installed packages, local sources and candidates use this importer. jiti's
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
      ...localPluginVirtualModules,
      '@agnes/protocol': protocol,
      // Same module the Host installer imported. A second copy would fork the kind token.
      '@agnes/intelligent-ui-contract': intelligentUiContract,
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
        // Use the nearest package manifest, including extension entries nested inside a package.
        for (let root = dirname(filename); ; root = dirname(root)) {
          const manifest = join(root, 'package.json')
          if (existsSync(manifest)) {
            const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
            checkPluginApiRanges(metadata.agnes?.plugins, metadata.name ?? 'plugin')
            checkProvidedExternals(metadata.agnes?.hostProvidedExternals)
            break
          }
          if (dirname(root) === root) break
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error
        if (error instanceof PluginModuleError) throw new PluginImportError(error)
        throw new HostError('E_EXT_LOAD', 'plugin manifest validation failed')
      }
      try {
        const result: unknown = await jiti.import(filename)
        if (result === null || typeof result !== 'object') throw new Error('invalid module namespace')
        return result as Record<string, unknown>
      } catch (error) {
        const failure = error instanceof PluginModuleError ? error : missingPluginModule(error)
        if (failure) throw new PluginImportError(failure)
        // Extension source and thrown values may contain credentials; never forward them.
        throw new HostError('E_EXT_LOAD', 'extension module evaluation failed')
      }
    },
  }
}
