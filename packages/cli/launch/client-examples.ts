import { join } from 'node:path'
import { createExamplePackages } from '@agnes/daemon/packages'
import type { PackageOperationReceipt, RuntimeAdminSnapshot } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import type { LocalBackend } from './backend.js'

/** This adapter alone holds the admin client; plugin pages receive only the fixed facade. */
export function localClientExamples(
  backend: LocalBackend,
  client: Client,
  initialize: () => Promise<unknown>,
) {
  const profile = backend.scope.profile
  const admin = client.packages
  const settled = async (submit: () => Promise<PackageOperationReceipt>) => {
    const receipt = await submit()
    const deadline = Date.now() + 120_000
    for (;;) {
      const op = await admin.operation.get({ profile, operationId: receipt.operationId })
      if (op.state === 'completed') return op
      if (['failed', 'cancelled', 'rolled-back'].includes(op.state)) throw new Error('E_PACKAGE_STATE')
      if (Date.now() >= deadline) throw new Error('OUTCOME_UNKNOWN')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const createFacade = () =>
    createExamplePackages({
      directory: join(backend.scope.daemonDir, 'example-launches'),
      backend: {
        async owner(rowId) {
          await initialize()
          const row = (await client.clientModules.list(profile)).rows.find((row) => row.rowId === rowId)
          if (!row) throw new Error('CAPABILITY_DENIED')
          const parent = (await admin.list({ profile })).packages.find((item) => item.id === row.packageId)
          if (!parent?.trusted || parent.desired !== 'enabled' || parent.blockers.length)
            throw new Error('CAPABILITY_DENIED')
          return { principal: await client.clientId(), profile, row, version: parent.version }
        },
        async catalog() {
          const items = []
          let cursor: string | undefined
          for (let page = 0; page < 32; page++) {
            const result = await admin.catalog.list({ profile, ...(cursor ? { cursor } : {}) })
            items.push(...result.items)
            cursor = result.nextCursor ?? undefined
            if (!cursor) return items
          }
          throw new Error('OVERLOADED')
        },
        async installed() {
          return (await admin.list({ profile })).packages
        },
        async inspect(entry, commandId) {
          const op = await settled(() =>
            admin.inspect({ profile, clientId: awaitClientId, commandId, source: entry.source }),
          )
          if (!op.preview) throw new Error('E_PACKAGE_STATE')
          return op.preview
        },
        async enable(review, operation, check) {
          const expected = review.preview
          const capabilityHash = expected.capabilityHash
          if (!capabilityHash) throw new Error('E_PACKAGE_PREVIEW_STALE')
          const parameters = (step: string) => ({
            profile,
            clientId: awaitClientId,
            commandId: `example-${operation}-${step}`,
          })
          let row = (await admin.list({ profile })).packages.find((row) => row.id === expected.id)
          await check()
          if (!row) {
            await settled(() =>
              admin.install({
                ...parameters('install'),
                source: review.entry.source,
                expectedIntegrity: expected.integrity,
              }),
            )
            row = (await admin.list({ profile })).packages.find((row) => row.id === expected.id)
          }
          const match = () => {
            if (
              !row ||
              row.integrity !== expected.integrity ||
              row.capabilityHash !== expected.capabilityHash ||
              row.blockers.length
            )
              throw new Error('E_PACKAGE_PREVIEW_STALE')
            return row
          }
          await check()
          if (!match().trusted) {
            await settled(() =>
              admin.trust({
                ...parameters('trust'),
                id: expected.id,
                expectedIntegrity: expected.integrity,
                capabilityHash,
              }),
            )
            row = (await admin.list({ profile })).packages.find((row) => row.id === expected.id)
          }
          await check()
          const current = match()
          if (current.desired !== 'enabled')
            await settled(() =>
              admin.enable({
                ...parameters('enable'),
                id: expected.id,
                expectedInstalledIntegrity: expected.integrity,
                expectedActiveIntegrity: current.actualIntegrity ?? null,
              }),
            )
          const deadline = Date.now() + 120_000
          for (;;) {
            await check()
            row = (await admin.list({ profile })).packages.find((row) => row.id === expected.id)
            const current = match()
            if (current.desired === 'enabled' && current.actual === 'running') return
            if (['failed', 'restart-required', 'unavailable'].includes(current.actual))
              throw new Error('E_PACKAGE_STATE')
            if (Date.now() >= deadline) throw new Error('OUTCOME_UNKNOWN')
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        },
        async validateLaunch(example, launch) {
          const runtime = await client.call<RuntimeAdminSnapshot>('_agnes/v1/sessionSelection.runtime', {})
          if (
            !runtime.bundles?.some(
              (bundle) => bundle.id === launch.bundle && bundle.sourcePackage === example.id,
            ) ||
            !example.presentation?.presets?.some(
              (preset) => preset.bundle === launch.bundle && preset.id === launch.preset,
            )
          )
            throw new Error('CAPABILITY_DENIED')
        },
        async open(launch, sessionKey) {
          return (
            await client.session.new({
              cwd: backend.scope.workspace,
              bundles: [launch.bundle],
              preset: launch.preset,
              sessionKey,
            })
          ).id
        },
        async prompt(sessionId, prompt, commandId) {
          const session = client.sessions.get(sessionId) ?? (await client.session.load(sessionId))
          await session.followUp(prompt, { commandId })
        },
      },
    })
  // localPackageAdmin supplies a fixed journal namespace that survives launcher restart.
  let awaitClientId = ''
  let facade: ReturnType<typeof createExamplePackages> | undefined
  return {
    async call(rowId: string, request: Record<string, unknown>) {
      await initialize()
      awaitClientId = await client.clientId()
      facade ??= createFacade()
      return facade.call(rowId, request)
    },
  }
}
