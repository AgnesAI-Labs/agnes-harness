import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgnesd } from '@agnes/daemon'
import { createHostProjectionOwner } from '@agnes/host'

const root = process.env.AGH_HOME
const log = process.env.FIRST_PATH_LOG
if (!root || !log) throw Error('Missing isolated fixture paths')
appendFileSync(log, `${JSON.stringify({ role: 'daemon', pid: process.pid })}\n`)
await runAgnesd(
  { home: root, profile: 'local-dev', dataDir: join(root, 'data'), workspace: root },
  {
    workerExecPath: process.execPath,
    workerExecArgv: ['--import', import.meta.resolve('tsx')],
    workerEntry: fileURLToPath(new URL('./runtime-first-path-worker.ts', import.meta.url)),
    // Pending client selection/bootstrap source only; no command, State or projection rights.
    ...(process.env.FIRST_PATH_BOOTSTRAP === 'fixture'
      ? ({
          runtimeClientInstallation: {
            queries: {},
            authorize: async () => ({ ok: true as const, value: true as const }),
            bootstrap: async (hello) => ({
              ok: true as const,
              value: {
                welcome: {
                  negotiatedSession: 'fixture-negotiated',
                  wireVersion: { major: 2, minor: 0 },
                  catalogRevision: 1,
                  capabilities: {
                    ...hello.capabilities,
                    negotiatedSession: 'fixture-negotiated',
                    effectivePolicyRevision: 1,
                  },
                  modules: [],
                  domainSchemas: [],
                  mode: 'compatible' as const,
                  reasons: [],
                  clientInstanceId: hello.capabilities.clientInstanceId,
                },
                catalogPage: { nextCursor: null, complete: true },
              },
            }),
          },
        } satisfies Pick<Parameters<typeof runAgnesd>[1] & {}, 'runtimeClientInstallation'>)
      : {}),
    // The real accepted-only store and default projection owner share the daemon lifetime.
    // Core publishes the real projection factory. No deployment installs its provider or issuer
    // here, and acceptInbox remains unavailable: default reads must name the missing installation.
    projection: {
      createOwner(sources) {
        const owner = createHostProjectionOwner(sources)
        return {
          ...owner,
          async close() {
            const state = await sources.commandStorage.transaction((tx) => ({
              state: tx.state(),
              sequence: tx.lastSequence(),
            }))
            const journal = await sources.journal(0, 10)
            appendFileSync(log, `${JSON.stringify({ role: 'domain-store', ...state, journal })}\n`)
            await owner.close()
          },
        }
      },
      store: {
        file: join(root, 'domain.sqlite'),
        owner: {
          authority: { authorityId: 'fixture-authority', tenantId: 'fixture-tenant', authorityEpoch: 1 },
          scope: { kind: 'runtime', installationId: 'fixture-installation', runtimeId: 'fixture-runtime' },
          ownerBinding: {
            contract: 'agh.projection',
            logicalName: 'default',
            providerId: 'fixture/projection',
            bindingId: 'fixture-projection',
          },
        },
        permits: async () => false,
      },
    },
  },
)
appendFileSync(log, `${JSON.stringify({ role: 'daemon-closed' })}\n`)
