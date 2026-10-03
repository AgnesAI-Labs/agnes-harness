import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { UIRegistryFactory } from '@agnes/extension-api/client'
import {
  type BuildIdentity,
  type ConformanceHarness,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  recoverUIRegistry,
  registerUIRegistryContract,
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
 * Runs this file as a client process and kills it with SIGKILL once it prints READY. Settles only once
 * the child's pipes have closed, so neither the process nor its handles outlive the call; a child that
 * neither gets ready nor exits within 15 seconds is killed and the call rejects.
 */
function runClient(args: readonly string[]): Promise<{ signal: string | null; pid: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', self, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    let timedOut = false
    const kill = () => {
      killed = true
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!killed && stdout.includes('READY\n')) kill()
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (_code, signal) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`ui registry client timed out\n${stderr}\n${stdout}`))
      else resolve({ signal, pid: child.pid ?? null })
    })
  })
}

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
    async restart(directory) {
      const killed = await runClient([directory, ...changed])
      return [killed, await runClient([directory, ...changed])]
    },
  })
}

/** The client process `restart` starts: `<directory> [<change module> <change name>]`. */
async function client(argv: readonly string[]): Promise<void> {
  const [directory, module, name] = argv
  if (directory === undefined) throw new Error('expected: <directory> [<change module> <change name>]')
  const change = module !== undefined && name !== undefined ? { module: new URL(module), name } : undefined
  recoverUIRegistry(await registryWith(change), directory, () => {
    writeSync(1, 'READY\n')
    // Blocks this thread, so the registry stays as it is until the process is killed.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  })
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  client(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'ui registry client failed'}\n`)
    process.exitCode = 1
  })
}
