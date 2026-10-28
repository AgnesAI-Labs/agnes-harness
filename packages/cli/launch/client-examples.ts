import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createAgentLaunches, createExamplePackages } from '@agnes/daemon/packages'
import type { PackageOperationReceipt } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import type { LocalBackend } from './backend.js'

/** This adapter alone holds the admin client; plugin pages receive only the fixed facade. */
export function localClientExamples(
  backend: LocalBackend,
  client: Client,
  initialize: () => Promise<unknown>,
) {
  const hostActivation = randomUUID()
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
        async runtime(exampleId) {
          await initialize()
          const result = await client.call<{ resources: { state: string; code?: string }[] }>(
            '_agnes/v1/pluginRuntime.status',
            { packageId: exampleId },
          )
          const failed = result.resources.find((row) => row.state === 'failed')
          return failed
            ? { state: 'failed', ...(failed.code ? { code: failed.code } : {}) }
            : {
                state:
                  result.resources.length === 0
                    ? 'unavailable'
                    : result.resources.every((row) => row.state === 'ready')
                      ? 'running'
                      : result.resources.some((row) => row.state === 'starting')
                        ? 'starting'
                        : 'stopped',
              }
        },
        async stop(exampleId, operationId) {
          const current = (await admin.list({ profile })).packages.find((item) => item.id === exampleId)
          if (!current) throw new Error('CAPABILITY_DENIED')
          await settled(() =>
            admin.disable({
              profile,
              id: exampleId,
              clientId: awaitClientId,
              commandId: `example-stop-${operationId}`,
            }),
          )
        },
        async remove(review, operationId, check) {
          await check()
          const row = (await admin.list({ profile })).packages.find((item) => item.id === review.entry.id)
          if (
            !row ||
            row.integrity !== review.preview.integrity ||
            row.capabilityHash !== review.preview.capabilityHash
          )
            throw new Error('E_PACKAGE_PREVIEW_STALE')
          if (row.desired === 'enabled') throw new Error('E_PACKAGE_STATE')
          await check()
          await settled(() =>
            admin.remove({
              profile,
              id: row.id,
              clientId: awaitClientId,
              commandId: `example-remove-${operationId}`,
            }),
          )
        },
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
        resolveAgent: (ref) => client.agents.resolve(ref),
        async open(plan, sessionKey) {
          return (
            await client.session.new({
              cwd: backend.scope.workspace,
              agent: plan.ref,
              agentDigest: plan.digest,
              sessionKey,
            })
          ).id
        },
      },
    })
  // localPackageAdmin supplies a fixed journal namespace that survives launcher restart.
  let awaitClientId = ''
  let facade: ReturnType<typeof createExamplePackages> | undefined
  const agents = createAgentLaunches({
    directory: join(backend.scope.daemonDir, 'agent-launches'),
    backend: {
      async caller(picked) {
        await initialize()
        const path = picked ?? backend.scope.workspace
        const workspace = (await client.workspace.list()).items.find(
          (row) => row.path === path && row.available,
        )
        if (!workspace) throw new Error('CAPABILITY_DENIED')
        return {
          principal: await client.clientId(),
          profile,
          workspace: path,
          activation: `${hostActivation}:${workspace.workspaceId ?? workspace.path}:${workspace.revision ?? 0}`,
        }
      },
      resolve: (ref) => client.agents.resolve(ref),
      application: () => client.call('_agnes/v1/applications.get', { profile }),
      async open(plan, sessionKey, workspace) {
        return (
          await client.session.new({
            cwd: workspace ?? backend.scope.workspace,
            agent: plan.ref,
            agentDigest: plan.digest,
            sessionKey,
          })
        ).id
      },
    },
  })
  return {
    async callAgent(request: Record<string, unknown>) {
      return agents.call(request)
    },
    async call(rowId: string, request: Record<string, unknown>) {
      await initialize()
      awaitClientId = await client.clientId()
      facade ??= createFacade()
      return facade.call(rowId, request)
    },
  }
}
