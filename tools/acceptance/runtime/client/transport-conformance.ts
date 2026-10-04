import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindTransportContract } from '../../../../examples/runtime-reference/src/providers/transport.js'
import type { RuntimeClientPorts } from '../../../../packages/daemon/src/runtime/transport.js'
import { listenWebSocket } from '../../../../packages/daemon/src/supervisor/ws.js'
import {
  registerTransportContract,
  type TransportAdmission,
  type TransportBacking,
  type TransportClient,
  type TransportClientOptions,
  type TransportServer,
} from '../../../../packages/extension-api/testkit/runtime/contracts/transport.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import { type JournalStore, memoryJournal } from '../../../../packages/sdk/src/journal.js'
import { subscriptions } from '../../../../packages/sdk/src/runtime/client-subscriptions.js'
import {
  RUNTIME_JOURNAL_KEY,
  RuntimeClientTransport,
} from '../../../../packages/sdk/src/runtime/client-transport.js'
import {
  getConformanceBuildIdentity,
  withConformanceBuild,
  withDeploymentStandIns,
} from '../build-identity.js'

const CONTRACT = 'agh.transport'
const PROVIDERS = ['default', 'reference'] as const
const RECIPE = 'packages/daemon/src/runtime/transport.ts'
const LISTENER = 'packages/daemon/src/supervisor/ws.ts'
const STAND_INS =
  "every route answers from the suite's recording owner in place of production ports, and the listener admits a synthetic bearer token over the fixture TLS certificate or a synthetic local page origin; not evidence for production ports or credential wiring"

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path))
const sha256 = (...paths: string[]) =>
  paths.reduce((hash, path) => hash.update(read(path)), createHash('sha256')).digest('hex')
const cert = read('tools/test-fixtures/tls/localhost-cert.pem').toString('utf8')
const key = read('tools/test-fixtures/tls/localhost-key.pem').toString('utf8')

/** The daemon's listener and runtime client routes over the cases' owner: bearer admission over TLS as
 * a remote daemon runs it, page-origin admission over loopback HTTP as the local Web runs it. */
async function startDefault(
  owner: TransportBacking,
  admission: TransportAdmission,
): Promise<TransportServer> {
  const runtimeClient = {
    bootstrap: (hello) => owner.bootstrap(hello),
    catalogPage: (request) => owner.catalogPage(request),
    subscribe: (request) => owner.subscribe(request),
    readSubscription: (request) => owner.readSubscription(request),
    closeSubscription: (request) => owner.closeSubscription(request),
    ...Object.fromEntries(
      owner.operations.map((operation) => [
        operation,
        (input: unknown, header: Parameters<TransportBacking['call']>[2]) =>
          owner.call(operation, input, header),
      ]),
    ),
  } as RuntimeClientPorts
  const listener = await listenWebSocket({
    addr: '127.0.0.1:0',
    ...(admission.kind === 'bearer'
      ? { cert, key, token: admission.credential }
      : { localOrigin: admission.origin, token: 'unused-local-token' }),
    endpoint: () => {
      throw new Error('no RPC session is opened by the transport cases')
    },
    runtimeClient,
  })
  return {
    baseUrl: listener.url.replace(/^ws/, 'http'),
    ...(admission.kind === 'bearer' ? { ca: cert } : {}),
    close: () => listener.close(),
  }
}

// One journal per name for the whole run, so a client made again under a name sees what the first left.
const journals = new Map<string, JournalStore>()

/** The SDK runtime client both providers are judged with, polling its subscriptions over HTTP. */
function sdkClient(options: TransportClientOptions): TransportClient {
  const journal = journals.get(options.journal) ?? memoryJournal(options.journal)
  journals.set(options.journal, journal)
  const transport = new RuntimeClientTransport({
    baseUrl: options.baseUrl,
    hello: options.hello,
    journal,
    fetch: options.fetch,
    ...(options.credential === undefined ? {} : { credential: options.credential }),
  })
  const { subscribe } = subscriptions(transport, { pollIntervalMs: options.pollIntervalMs })
  return Object.assign(transport, {
    subscribe,
    pending: async () => (await journal.pending(RUNTIME_JOURNAL_KEY)).map((entry) => entry.commandId),
  })
}

// The daemon route layer on its real listener, and the reference server, both driven by the SDK client.
// Each case closes the listeners it starts, so nothing outlives the run.
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
      bindTransportContract(withConformanceBuild(harness), request.command, { providerId, client: sdkClient })
    else
      registerTransportContract(withDeploymentStandIns(harness, STAND_INS), {
        providerId,
        recipe: RECIPE,
        command: request.command,
        build: getConformanceBuildIdentity(),
        providerDigest: sha256(RECIPE, LISTENER),
        configDigest: canonicalJsonDigest({}),
        releaseSetDigest: sha256('packages/daemon/package.json'),
        admissions: ['bearer', 'page-origin'],
        start: startDefault,
        client: sdkClient,
      })
  }
  return { contracts: [CONTRACT], providers }
}
