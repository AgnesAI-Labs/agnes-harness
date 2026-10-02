import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  type BuildIdentity,
  type ConformanceHarness,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  crashProjection,
  createProjectionFixture,
  type ProjectionContractPort,
  type ProjectionCrash,
  type ProjectionFixture,
  projectionContractPort,
  registerProjectionContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/projection.js'
import { openProjectionStore, PROJECTION_PROVIDER, type ProjectionStore } from './projection.js'

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

const CHECKPOINT_EVERY = 4

/** Opens the reference store wired to a fixture, with a clock whose ids never repeat across reopens. */
export function openReferenceProjection(
  databasePath: string,
  fixture: ProjectionFixture,
  providerId: string = PROJECTION_PROVIDER.id,
) {
  const binding: Wire.BindingRef = {
    bindingId: `reference-projection-${providerId}`,
    contract: 'agh.projection',
    logicalName: 'tasks',
    providerId,
  }
  let ids = 0
  /** Opens a store over `path`, which may be a file that is not a projection store. */
  const mount = (path: string) =>
    openProjectionStore(path, {
      binding,
      authorityId: 'reference-projection-authority',
      domain: fixture.domain,
      access: fixture.gate,
      native: fixture.native,
      turnOf: fixture.turnOf,
      checkpointEvery: CHECKPOINT_EVERY,
      clock: { now: () => '2026-10-01T00:00:00.000Z', newId: () => `reference-${++ids}` },
    })
  let current: ProjectionStore = mount(databasePath)
  return {
    binding,
    current: () => current,
    mount,
    reopen() {
      current.close()
      current = mount(databasePath)
    },
  }
}

const self = fileURLToPath(import.meta.url)
const root = fileURLToPath(new URL('../../../..', import.meta.url))

type Killed = { signal: string | null; pid: number | null; stdout: string; stderr: string }

/**
 * Runs this file as a provider process and kills it with SIGKILL the first time `ready` accepts its
 * output. Settles only once the child's pipes have closed, so neither the process nor its handles
 * outlive the call; a child that never gets ready is killed after 15 seconds and the call rejects.
 */
function killWhenReady(args: readonly string[], ready: (stdout: string) => boolean): Promise<Killed> {
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
      if (!killed && ready(stdout)) kill()
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (_code, signal) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`projection child timed out\n${stderr}\n${stdout}`))
      else resolve({ signal, pid: child.pid ?? null, stdout, stderr })
    })
  })
}

/** Drives the reference store through the six scenarios; the contract module judges what it reports. */
export function referenceProjectionPort(
  databasePath: string,
  providerId: string = PROJECTION_PROVIDER.id,
): { port: ProjectionContractPort; close(): void } {
  const fixture = createProjectionFixture()
  const store = openReferenceProjection(databasePath, fixture, providerId)
  const port = projectionContractPort({
    binding: {
      requirement: {
        contract: 'agh.projection',
        major: 1,
        logicalName: 'tasks',
        features: [],
        scope: 'workspace',
        optional: false,
      },
      binding: store.binding,
      query: (request, context) => store.current().query(request, context),
    },
    fixture,
    service: () => store.current(),
    append: async (events) => store.current().append(events),
    async crash(crash) {
      store.current().close()
      try {
        const killed = await killWhenReady(['crash', databasePath, JSON.stringify(crash)], (stdout) =>
          stdout.includes('READY\n'),
        )
        return { signal: killed.signal, pid: killed.pid }
      } finally {
        store.reopen()
      }
    },
    close: async () => store.current().close(),
    remains: () => existsSync(databasePath),
    mountRefused() {
      const garbage = `${databasePath}.garbage`
      writeFileSync(garbage, 'not a projection store\n'.repeat(200))
      try {
        store.mount(garbage).close()
        return false
      } catch {
        return true
      }
    },
    remount() {
      store.reopen()
      store.current().close()
    },
  })
  return { port, close: () => store.current().close() }
}

/**
 * Registers the six projection cases for the reference provider on a fresh database, reported under
 * `providerId` (the runner passes the name it was asked for, such as `reference`). `change` lets a
 * test break one scenario to prove the contract notices. Call `close` after the harness has run.
 */
export function bindProjectionContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{
    providerId?: string
    change?: (port: ProjectionContractPort) => ProjectionContractPort
  }> = {},
): { close(): void } {
  const providerId = options.providerId ?? PROJECTION_PROVIDER.id
  const directory = mkdtempSync(join(tmpdir(), 'reference-projection-contract-'))
  const reference = referenceProjectionPort(join(directory, 'projection.sqlite'), providerId)
  registerProjectionContract(harness, {
    providerId,
    recipe: providerFileForContract('agh.projection'),
    command,
    build,
    providerDigest: sha256(new URL('./projection.ts', import.meta.url)),
    configDigest: canonicalJsonDigest({ checkpointEvery: CHECKPOINT_EVERY }),
    releaseSetDigest: sha256(new URL('../../package.json', import.meta.url)),
    port: options.change ? options.change(reference.port) : reference.port,
  })
  return {
    close() {
      reference.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** The provider process a crash starts: `crash <database> <ProjectionCrash as JSON>`. */
async function crashChild(argv: readonly string[]): Promise<void> {
  const [command, databasePath, crash] = argv
  if (command !== 'crash' || databasePath === undefined || crash === undefined)
    throw new Error('expected: crash <database> <crash>')
  const fixture = createProjectionFixture()
  const store = openReferenceProjection(databasePath, fixture)
  const subject = {
    fixture,
    service: () => store.current(),
    append: async (events: readonly Wire.DomainEvent[]) => store.current().append(events),
  }
  await crashProjection(subject, JSON.parse(crash) as ProjectionCrash, () => {
    writeSync(1, 'READY\n')
    // Blocks this thread, so nothing after the held prepare can run before the kill.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  })
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  crashChild(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'projection child failed'}\n`)
    process.exitCode = 1
  })
}
