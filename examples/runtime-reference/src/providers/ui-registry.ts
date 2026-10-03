import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { UIRegistryFactory } from '@agnes/extension-api/client'
import {
  type BuildIdentity,
  type ConformanceHarness,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  holdUIRegistryClient,
  recoverUIRegistry,
  registerUIRegistryContract,
  restartUIRegistryClient,
} from '../../../../packages/extension-api/testkit/runtime/contracts/ui-registry.js'
import { createReferenceUIRegistry } from '../client/ui-registry.js'

// Assigning the generic browser factory here checks its mirrored shapes against the generated types.
const reference: UIRegistryFactory = createReferenceUIRegistry

/** A module and the name of its export, `(factory) => factory`, that breaks the registry for a test. */
export type UIRegistryChange = Readonly<{ module: URL; name: string }>

async function registryWith(change: UIRegistryChange | undefined): Promise<UIRegistryFactory> {
  if (change === undefined) return reference
  const loaded = (await import(change.module.href)) as Record<string, unknown>
  const breaks = loaded[change.name]
  if (typeof breaks !== 'function') throw new Error(`no registry change named ${change.name}`)
  return (breaks as (factory: UIRegistryFactory) => UIRegistryFactory)(reference)
}

const sha256 = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex')

const build: BuildIdentity = {
  codeSha: 'reference-code',
  buildDigest: 'reference-build',
  lockDigest: 'reference-lock',
  specVersion: 'reference-spec',
  sdkVersion: 'reference-sdk',
  sdkDigest: 'reference-sdk-digest',
  platform: 'reference-platform',
}

const self = fileURLToPath(import.meta.url)
const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * Registers the six UI registry cases for the browser-side reference registry, reported under
 * `providerId` (the runner passes the name it was asked for, such as `reference`). `change` lets a test
 * break the registry, in this process and in the client processes `recover` starts, to prove the
 * contract notices.
 */
export async function bindUIRegistryContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{ providerId?: string; change?: UIRegistryChange }> = {},
): Promise<void> {
  const changed = options.change ? [options.change.module.href, options.change.name] : []
  registerUIRegistryContract(harness, {
    providerId: options.providerId ?? 'reference.ui-registry',
    recipe: providerFileForContract('agh.ui-registry'),
    command,
    build,
    providerDigest: sha256(new URL('../client/ui-registry.ts', import.meta.url)),
    configDigest: canonicalJsonDigest({}),
    releaseSetDigest: sha256(new URL('../../package.json', import.meta.url)),
    factory: await registryWith(options.change),
    restart: (directory) => restartUIRegistryClient(['--import', 'tsx', self, directory, ...changed], root),
  })
}

/** The client process `restart` starts: `<directory> [<change module> <change name>]`. */
async function client(argv: readonly string[]): Promise<void> {
  const [directory, module, name] = argv
  if (directory === undefined) throw new Error('expected: <directory> [<change module> <change name>]')
  const change = module !== undefined && name !== undefined ? { module: new URL(module), name } : undefined
  recoverUIRegistry(await registryWith(change), directory, holdUIRegistryClient)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  client(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'ui registry client failed'}\n`)
    process.exitCode = 1
  })
}
