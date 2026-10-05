import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bindEventsContract } from '../../../../examples/runtime-reference/src/providers/events-contract.js'
import { killWhenReady } from '../../../../examples/runtime-reference/src/providers/interaction-contract.js'
import { openDomainStore } from '../../../../packages/daemon/src/runtime/events/outbox.js'
import { createEventsProvider } from '../../../../packages/daemon/src/runtime/providers/events.js'
import {
  crashEvents,
  createEventsFixture,
  type EventsCrash,
  type EventsFixture,
  type EventsSubject,
  eventsContractPort,
  registerEventsContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/events.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import type * as Wire from '../../../../packages/protocol/src/runtime/index.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import {
  getConformanceBuildIdentity,
  withConformanceBuild,
  withDeploymentStandIns,
} from '../build-identity.js'

const CONTRACT = 'agh.events'
const PROVIDERS = ['default', 'reference'] as const
const RECIPE = 'packages/daemon/src/runtime/providers/events.ts'
const STAND_INS =
  "the events gate is the suite's fixture gate and the domain store is a test SQLite database; not evidence for the Host publication authority or storage composition"
// Its own logical name, so the run's one test service container holds it beside the reference store.
const LOGICAL_NAME = 'events-default'
const BINDING: Wire.BindingRef = {
  bindingId: 'default-events',
  contract: CONTRACT,
  logicalName: LOGICAL_NAME,
  providerId: 'default',
}
const OWNER: Wire.RecordOwner = {
  authority: { authorityId: 'default-events-authority', tenantId: 'conformance', authorityEpoch: 1 },
  scope: {
    kind: 'workspace',
    installationId: 'conformance',
    runtimeId: 'conformance',
    workspaceId: 'conformance',
  },
  ownerBinding: BINDING,
}
// One cursor key per process, as the daemon holds it: cursors survive a reopen here, never a restart.
const CURSOR_KEY = randomBytes(32)

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const self = fileURLToPath(import.meta.url)
const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex')

/** The default provider over its own domain store at `file`, which may be a file that is no store. */
const mount = (file: string, fixture: EventsFixture) =>
  createEventsProvider({
    binding: BINDING,
    store: openDomainStore({ file, owner: OWNER, permits: async () => false }),
    cursorKey: CURSOR_KEY,
    gate: fixture.gate,
    ownsStore: true,
  })

/** The default provider as the shared suite drives it, over the domain store at `path`. */
function defaultSubject(path: string, fixture: EventsFixture): EventsSubject {
  let current = mount(path, fixture)
  return {
    binding: {
      requirement: {
        contract: CONTRACT,
        major: 1,
        logicalName: LOGICAL_NAME,
        features: [],
        scope: 'runtime',
        optional: false,
      },
      binding: BINDING,
      query: (request, context) => current.query(request, context),
    },
    fixture,
    service: () => current,
    async crash(crash) {
      current.close()
      try {
        const killed = await killWhenReady(
          [path, JSON.stringify(crash)],
          (stdout) => stdout.includes('READY\n'),
          self,
        )
        return { signal: killed.signal, pid: killed.pid }
      } finally {
        current = mount(path, fixture)
      }
    },
    close: () => current.close(),
    reopen() {
      current.close()
      current = mount(path, fixture)
    },
    remains: () => existsSync(path),
    mountRefused() {
      const garbage = `${path}.garbage`
      writeFileSync(garbage, 'not a domain store\n'.repeat(200))
      try {
        mount(garbage, fixture).close()
        return false
      } catch {
        return true
      }
    },
  }
}

/** Registers the six events cases for the daemon default provider on a fresh test database. */
function bindDefaultEventsContract(harness: ConformanceHarness, command: string): void {
  const path = join(mkdtempSync(join(tmpdir(), 'default-events-contract-')), 'domain.sqlite')
  registerEventsContract(withDeploymentStandIns(harness, STAND_INS), {
    providerId: 'default',
    recipe: RECIPE,
    command,
    build: getConformanceBuildIdentity(),
    providerDigest: sha256(RECIPE),
    configDigest: canonicalJsonDigest({ owner: OWNER, logicalName: LOGICAL_NAME }),
    releaseSetDigest: sha256('packages/daemon/package.json'),
    port: eventsContractPort(defaultSubject(path, createEventsFixture())),
  })
}

// The daemon default provider, over the test database above, and the reference store bind here. The
// runner has no teardown, so the databases live until the process exits.
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes(CONTRACT))
    return { contracts: [], providers: [] }
  const providers = PROVIDERS.filter((providerId) => request.providers.includes(providerId))
  for (const providerId of providers) {
    if (providerId === 'reference')
      bindEventsContract(withConformanceBuild(harness), request.command, { providerId })
    else bindDefaultEventsContract(harness, request.command)
  }
  return { contracts: [CONTRACT], providers }
}

// The provider process `recover` starts: `<database> <EventsCrash as JSON>`. It is killed at READY.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const [path, crash] = process.argv.slice(2)
  if (path === undefined || crash === undefined) throw new Error('expected: <database> <crash>')
  crashEvents(defaultSubject(path, createEventsFixture()), JSON.parse(crash) as EventsCrash, () => {
    writeSync(1, 'READY\n')
    // Blocks this thread, so nothing after the held admission can run before the kill.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'events child failed'}\n`)
    process.exitCode = 1
  })
}
