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
  crashEvents,
  createEventsFixture,
  type EventsContractPort,
  type EventsCrash,
  type EventsFixture,
  eventsContractPort,
  registerEventsContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/events.js'
import { EVENTS_PROVIDER, openEventsStore } from './events.js'
import { killWhenReady } from './interaction-contract.js'

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

const AUTHORITY = 'reference-events-authority'

/** Opens the reference store over `path`, wired to a fixture's Host checks. */
function openReferenceEvents(path: string, fixture: EventsFixture, providerId: string) {
  const binding: Wire.BindingRef = {
    bindingId: `reference-events-${providerId}`,
    contract: EVENTS_PROVIDER.contract,
    logicalName: 'events',
    providerId,
  }
  /** Opens a store over `file`, which may be a file that is not an events store. */
  const mount = (file: string) =>
    openEventsStore(file, { binding, authorityId: AUTHORITY, access: fixture.gate })
  let current = mount(path)
  return {
    binding,
    current: () => current,
    mount,
    reopen() {
      current.close()
      current = mount(path)
    },
  }
}

const self = fileURLToPath(import.meta.url)

/** Drives the reference store through the six scenarios; the contract module judges what it reports. */
export function referenceEventsPort(
  path: string,
  providerId: string = EVENTS_PROVIDER.id,
): { port: EventsContractPort; close(): void } {
  const fixture = createEventsFixture()
  const store = openReferenceEvents(path, fixture, providerId)
  const port = eventsContractPort({
    binding: {
      requirement: {
        contract: EVENTS_PROVIDER.contract,
        major: 1,
        logicalName: 'events',
        features: [],
        scope: 'runtime',
        optional: false,
      },
      binding: store.binding,
      query: (request, context) => store.current().query(request, context),
    },
    fixture,
    service: () => store.current(),
    async crash(crash) {
      store.current().close()
      try {
        const killed = await killWhenReady(
          ['crash', path, JSON.stringify(crash)],
          (stdout) => stdout.includes('READY\n'),
          self,
        )
        return { signal: killed.signal, pid: killed.pid }
      } finally {
        store.reopen()
      }
    },
    close: () => store.current().close(),
    reopen: () => store.reopen(),
    remains: () => existsSync(path),
    mountRefused() {
      const garbage = `${path}.garbage`
      writeFileSync(garbage, 'not an events store\n'.repeat(200))
      try {
        store.mount(garbage).close()
        return false
      } catch {
        return true
      }
    },
  })
  return { port, close: () => store.current().close() }
}

/**
 * Registers the six events cases for the reference provider on a fresh database, reported under
 * `providerId` (the runner passes the name it was asked for, such as `reference`). `change` lets a test
 * break one scenario to prove the contract notices. Call `close` after the harness has run.
 */
export function bindEventsContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{ providerId?: string; change?: (port: EventsContractPort) => EventsContractPort }> = {},
): { close(): void } {
  const providerId = options.providerId ?? EVENTS_PROVIDER.id
  const directory = mkdtempSync(join(tmpdir(), 'reference-events-contract-'))
  const reference = referenceEventsPort(join(directory, 'events.sqlite'), providerId)
  registerEventsContract(harness, {
    providerId,
    recipe: providerFileForContract(EVENTS_PROVIDER.contract),
    command,
    build,
    providerDigest: sha256(new URL('./events.ts', import.meta.url)),
    configDigest: canonicalJsonDigest({ authorityId: AUTHORITY }),
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

/** The provider process a crash starts: `crash <database> <EventsCrash as JSON>`. */
async function crashChild(argv: readonly string[]): Promise<void> {
  const [command, path, crash] = argv
  if (command !== 'crash' || path === undefined || crash === undefined)
    throw new Error('expected: crash <database> <crash>')
  const fixture = createEventsFixture()
  const store = openReferenceEvents(path, fixture, EVENTS_PROVIDER.id)
  await crashEvents({ fixture, service: () => store.current() }, JSON.parse(crash) as EventsCrash, () => {
    writeSync(1, 'READY\n')
    // Blocks this thread, so nothing after the held admission can run before the kill.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  })
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  crashChild(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'events child failed'}\n`)
    process.exitCode = 1
  })
}
