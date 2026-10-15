import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSeams } from '@agnes/core/testkit'
import { BoundWakeService } from '@agnes/daemon-foundation/jobs/bound-wakes'
import { JobsRepo } from '@agnes/daemon-foundation/jobs/repo'
import { ServiceRegistry } from '@agnes/host-extensions/ext-host/services'
import { ProfileActivations } from '@agnes/host-extensions/profile/activation'
import { ownedStore } from '@agnes/host-extensions/profile/owned-store'
import { createProfileServiceRuntime } from '@agnes/host-extensions/profile/runtime'
import { ProfileWakeBindings } from '@agnes/host-extensions/profile/wakes'
import { openConfiguredPersistence } from '@agnes/host-infrastructure/adapters/storage-provider'
import { createMhsNativeProfileAdapter, mhsOwnedStore } from '@agnes/mhs'
import { type Hub, North } from '@agnes/mhs-hub'

/** Real SQLite, native AR1, owner store and durable jobs; only inventory/credential edges are synthetic. */
export async function nativeHarness(signal?: AbortSignal) {
  const directory = mkdtempSync(join(tmpdir(), 'agh-mars-authority-'))
  const storage = await openConfiguredPersistence({ dataDir: directory })
  const owner = 'plugin/0123456789abcdef',
    integrity = 'mars-reviewed',
    profileId = 'mars-profile'
  const credential = Object.freeze({ kind: 'synthetic-mars-operator' })
  const activations = new ProfileActivations(storage.metadata.namespace('@host', 'activation'))
  activations.publish([{ owner, revision: integrity }])
  const alive = () => {
    activations.require(owner, integrity)
  }
  const current = async () => {
    alive()
    signal?.throwIfAborted()
  }
  const adapter = createMhsNativeProfileAdapter(current)
  const store = mhsOwnedStore(ownedStore(storage.metadata.namespace(owner, 'hub'), alive, true))
  const bindings = new ProfileWakeBindings(storage.metadata.namespace('@host', 'wakes'), activations)
  const table = storage.tables('@host/mars-jobs').table('jobs')
  const repo = () =>
    new JobsRepo(
      {
        exec(sql, params) {
          if (params) table.run(sql, params)
          else table.exec(sql)
        },
        get<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
          return table.get<T>(sql, params)
        },
        all<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
          return table.all<T>(sql, params)
        },
        transaction: (work) => table.transaction(work),
      },
      Date.now,
    )
  const registry = new ServiceRegistry()
  let services: ReturnType<typeof createProfileServiceRuntime> | undefined
  const makeWakes = () =>
    new BoundWakeService({
      repo: repo(),
      profileHash: 'mars-synthetic-profile',
      clock: Date.now,
      resolve: (id, input) => {
        if (!services) throw new Error('native-runtime-unbound')
        return services.resolveWake(id, input)
      },
    })
  const queue = makeWakes()
  const wakes = {
    enqueue: (input: Parameters<BoundWakeService['enqueue']>[0]) => queue.enqueue(input, credential),
  }
  return {
    owner,
    credential,
    activations,
    adapter,
    store,
    current,
    bindings,
    queue,
    makeWakes,
    repo,
    target() {
      return bindings.bind(
        {
          producerOwner: owner,
          producerIntegrity: integrity,
          producerPackageId: '@agnes/mhs',
          producerVersion: '0.0.0',
          profileId,
          sessionId: 'rescue-session',
          laneId: 'main',
          generationId: 'synthetic-rescue-generation',
          actorId: 'u',
          actorOrg: 'local',
        },
        'mars-watch-target',
      )
    },
    wakes,
    attach(hub: Hub) {
      const definitions = adapter.definitions(new North(hub))
      for (const definition of definitions)
        registry.registerRow(definition, {
          owner,
          packageId: '@agnes/mhs',
          integrity,
          version: '0.0.0',
          signal: signal ?? new AbortController().signal,
          assertAlive: alive,
          assertRunning: alive,
          consume: alive,
        })
      services = createProfileServiceRuntime({
        profileId,
        registry,
        activations,
        wakes: bindings,
        storage,
        metadata: storage.metadata,
        authority: {
          async resolve(input) {
            if (input !== credential) throw new Error('foreign-credential')
            return {
              source: 'client-web',
              subjectCredential: credential,
              sessionReads: ['rescue-session'],
              grants: [
                ...definitions.map((d) => ({ extension: owner, name: d.name, range: '*' })),
                { extension: owner, name: 'wake.enqueue', range: '*' },
              ],
            }
          },
        },
        // No seam may manufacture approval: movement must receive an AR1 decision answer.
        seams: fakeSeams({
          approval: {
            async ask() {
              throw new Error('use-native-AR1')
            },
          },
        }),
        log: { debug() {}, info() {}, warn() {}, error() {} },
        clock: Date.now,
        signal: signal ?? new AbortController().signal,
        networkAllow: [],
        audit() {},
      })
      return services
    },
    async answer(option: 'allowed-once' | 'rejected') {
      if (!services) throw new Error('native-runtime-unbound')
      const decision = (await services.listDecisions(credential))[0]
      if (!decision) throw new Error('missing-native-decision')
      await services.answerDecision(
        {
          handle: decision.handle,
          revision: decision.revision,
          commandId: crypto.randomUUID(),
          response: { option, value: null },
        },
        credential,
      )
      return decision
    },
    async close() {
      await services?.close()
      await storage.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
