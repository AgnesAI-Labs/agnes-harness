import { closeSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import type { RuntimeError } from '@agnes/protocol/runtime'
import { createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import { createHostRuntimeClientPorts } from '../../src/runtime/client-ports.js'
import { createLocalDeploymentIdentity } from '../../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../../src/runtime/identity/local-deployment-owner.js'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import { createBootstrapAnchor } from '../../src/runtime/maintenance/bootstrap-locator.js'
import {
  assembleHostProjectionOwner,
  type HostProjectionProvider,
} from '../../src/runtime/projection-owner.js'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-deployment-identity-')))
  const deploymentDirectory = join(root, 'deployment')
  const anchor = createBootstrapAnchor(deploymentDirectory, {
    principalRef: 'not-an-authentication-proof',
    locator: {
      directoryId: 'directory',
      providerLockRef: inlineData({ locator: true }, 'agh.maintenance/provider-lock@1'),
      endpointRef: deploymentDirectory,
      epoch: 1,
      revision: 1,
      cutoverId: 'cutover',
    },
  })
  if (!anchor.ok) throw new Error(anchor.error.detailCode)
  const file = join(deploymentDirectory, 'state.sqlite')
  closeSync(createPrivateFileSync(file))
  const database = new DatabaseSync(file)
  let at = Date.parse('2026-10-04T00:00:00Z')
  let clockHook: (() => void) | undefined
  const options = {
    database,
    deploymentDirectory,
    owner: captureLocalDeploymentOwner({ database, deploymentDirectory }),
    authority: { authorityId: 'state-authority', tenantId: 'tenant', authorityEpoch: 1 },
    scope: {
      kind: 'session' as const,
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    now: () => {
      clockHook?.()
      return at
    },
  }
  return {
    options,
    database,
    file,
    deploymentDirectory,
    clock(hook?: () => void) {
      clockHook = hook
    },
    advance(ms: number) {
      at += ms
    },
    close() {
      if (database.isOpen) database.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe.skipIf(typeof process.getuid !== 'function')('local original C14 deployment identity', () => {
  it('binds projection reads to original issued contexts, refreshes commits and drains its owner', async () => {
    const f = fixture()
    const identity = createLocalDeploymentIdentity(f.options)
    let connection: Awaited<ReturnType<typeof identity.connect>> | undefined
    let listener: (() => Promise<RuntimeError | null>) | undefined
    let durable = 0
    let revision = 0
    let disposed = false
    let clone = false
    let revokeRead = false
    let refreshError: RuntimeError | null = null
    const observed: string[] = []
    const seen = (name: string, context: CallContext) => {
      identity.capture(context).dynamicCheck()
      expect(context.principalRef).toBe(f.options.owner.facts.principalRef)
      observed.push(name)
    }
    const refusal = {
      ok: false as const,
      error: {
        code: 'incompatible' as const,
        detailCode: 'fixture_no_native_window',
        message: 'no native window',
        diagnosticId: 'fixture',
        retryAdvice: { kind: 'never' as const },
      },
    }
    const provider: HostProjectionProvider = {
      async openConversation(input, context) {
        seen(input.sessionId, context)
        return refusal
      },
      async conversationHistory(input, context) {
        seen(input.cursor, context)
        return refusal
      },
      async listConversations(input, context) {
        seen(input.text ?? '', context)
        return { ok: true, value: { items: [], snapshot: 'list', nextCursor: null, complete: true } }
      },
      async snapshot(_input, context) {
        seen('snapshot', context)
        if (revokeRead) identity.revoke()
        return {
          ok: true,
          value: {
            items: [],
            cursor: 'cut',
            projectionRevision: revision,
            nextPageCursor: null,
            complete: true,
          },
        }
      },
      async commandStatus(input, context) {
        seen(input, context)
        return {
          ok: true,
          value: {
            requestId: input,
            status: 'not-accepted',
            commandId: null,
            revision: null,
            completion: null,
            result: null,
            error: null,
          },
        }
      },
      async refresh() {
        revision = durable
        return refreshError
      },
      close() {
        disposed = true
      },
    }
    const owner = assembleHostProjectionOwner({
      provider,
      disposeContextIssuer() {
        connection?.close()
      },
      async issue(_caller, _request, signal) {
        connection ??= await identity.connect(signal)
        const context = connection.issue('2026-10-04T00:01:00Z', 'projection-trace')
        return { ok: true, value: clone ? { ...context } : context }
      },
      subscribeCommitted(next) {
        listener = next
        return () => {
          listener = undefined
        }
      },
    })
    const caller = { principalId: 'local' as const, generation: 'daemon-generation' }
    const ports = createHostRuntimeClientPorts(owner.installation, caller)
    const header = { negotiatedSession: 's1', clientInstanceId: 'ci1', catalogRevision: 1, callId: 'call1' }
    const query = {
      domainType: 'fixture',
      query: inlineData(null, 'fixture/query@1'),
      scope: f.options.scope,
      cursor: null,
      limit: 1,
    }
    try {
      expect(await ports['domain.query']?.(query, header)).toMatchObject({
        ok: true,
        value: { projectionRevision: 0 },
      })
      durable = 1
      expect(await listener?.()).toBeNull()
      expect(await ports['domain.query']?.(query, header)).toMatchObject({
        ok: true,
        value: { projectionRevision: 1 },
      })
      await ports['conversation.open']?.({ sessionId: 'session', limit: 1 }, header)
      await ports['conversation.history']?.({ sessionId: 'session', cursor: 'page', limit: 1 }, header)
      await ports['conversation.list']?.(
        {
          scope: {
            kind: 'workspace',
            installationId: 'installation',
            runtimeId: 'runtime',
            workspaceId: 'workspace',
          },
          text: 'list',
          cursor: null,
          limit: 1,
        },
        header,
      )
      expect(await ports['domain.commandStatus']?.('request-id', header)).toMatchObject({
        ok: true,
        value: { requestId: 'request-id' },
      })
      expect(observed).toEqual(['snapshot', 'snapshot', 'session', 'page', 'list', 'request-id'])
      clone = true
      expect(await ports['domain.query']?.(query, header)).toMatchObject({
        ok: false,
        error: { detailCode: 'projection_context_not_current' },
      })
      clone = false
      refreshError = refusal.error
      expect(await listener?.()).toEqual(refreshError)
      expect(await ports['domain.query']?.(query, header)).toEqual(refusal)
      refreshError = null
      expect(await listener?.()).toBeNull()
      revokeRead = true
      expect(await ports['domain.query']?.(query, header)).toMatchObject({
        ok: false,
        error: { detailCode: 'projection_context_not_current' },
      })
    } finally {
      await owner.close()
      expect(listener).toBeUndefined()
      expect(disposed).toBe(true)
      expect(
        f.database
          .prepare('SELECT count(*) AS n FROM runtime_local_identity_connections WHERE closed=0')
          .get()?.n,
      ).toBe(0)
      expect(await owner.committed()).toMatchObject({ detailCode: 'projection_owner_closed' })
      await owner.close()
      connection?.close()
      identity.close()
      f.close()
    }
  })
  it('aborts and drains an in-flight projection read before closing its provider', async () => {
    const f = fixture()
    const identity = createLocalDeploymentIdentity(f.options)
    let connection: Awaited<ReturnType<typeof identity.connect>> | undefined
    let entered!: () => void
    const pending = new Promise<void>((resolve) => {
      entered = resolve
    })
    let drained = false
    let disposed = false
    const unavailable = async () => {
      throw new Error('unused projection method')
    }
    const owner = assembleHostProjectionOwner({
      provider: {
        openConversation: unavailable,
        conversationHistory: unavailable,
        listConversations: unavailable,
        commandStatus: unavailable,
        async snapshot(_request, context) {
          entered()
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          drained = true
          return {
            ok: true,
            value: { items: [], cursor: 'cut', projectionRevision: 0, nextPageCursor: null, complete: true },
          }
        },
        refresh: async () => null,
        close() {
          expect(drained).toBe(true)
          disposed = true
        },
      },
      disposeContextIssuer() {
        connection?.close()
      },
      async issue(_caller, _request, signal) {
        connection = await identity.connect(signal)
        return { ok: true, value: connection.issue('2026-10-04T00:01:00Z', 'projection-trace') }
      },
    })
    const ports = createHostRuntimeClientPorts(owner.installation, { principalId: 'local', generation: 'g' })
    const read = ports['domain.query']?.(
      {
        domainType: 'fixture',
        query: inlineData(null, 'fixture/query@1'),
        scope: f.options.scope,
        cursor: null,
        limit: 1,
      },
      { negotiatedSession: 's1', clientInstanceId: 'ci1', catalogRevision: 1, callId: 'call1' },
    )
    try {
      await pending
      await owner.close()
      expect(await read).toMatchObject({ ok: false, error: { detailCode: 'projection_owner_closed' } })
      expect(disposed).toBe(true)
    } finally {
      await owner.close()
      connection?.close()
      identity.close()
      f.close()
    }
  })
  it('authenticates from the original OS connection and consumes the real issued context', async () => {
    const f = fixture()
    const identity = createLocalDeploymentIdentity(f.options)
    try {
      const connection = await identity.connect(new AbortController().signal)
      expect(connection.actor.identity.authKind).toBe('local')
      expect(connection.actor.identity.principalRef).not.toBe('not-an-authentication-proof')
      const context = connection.issue('2026-10-04T00:01:00Z', 'trace')
      const cap = identity.capture(context)
      cap.dynamicCheck()
      cap.finalCheck()
      expect(() => identity.capture({ ...context })).toThrow()
      expect(f.database.prepare('SELECT count(*) AS n FROM runtime_identity_instances').get()?.n).toBe(1)
      connection.close()
      expect(() => identity.capture(context)).toThrow()
    } finally {
      identity.close()
      f.close()
    }
  })
  it('rejects cloned OS capabilities and a foreign connection before installing any tables', () => {
    const f = fixture()
    const foreign = new DatabaseSync(f.file)
    try {
      expect(() => createLocalDeploymentIdentity({ ...f.options, owner: { ...f.options.owner } })).toThrow()
      expect(() => createLocalDeploymentIdentity({ ...f.options, database: foreign })).toThrow()
      expect(
        f.database
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'runtime_local_identity_%'")
          .get()?.n,
      ).toBe(0)
    } finally {
      foreign.close()
      f.close()
    }
  })
  it('rolls back a real generation revocation in the final issuer clock', async () => {
    const f = fixture()
    const identity = createLocalDeploymentIdentity(f.options)
    try {
      const c = await identity.connect(new AbortController().signal)
      const ctx = c.issue('2026-10-04T00:01:00Z', 'trace')
      const cap = identity.capture(ctx)
      cap.dynamicCheck()
      let changes = 0
      f.database.exec('BEGIN IMMEDIATE')
      f.clock(() => {
        f.clock()
        changes = Number(
          f.database.prepare('UPDATE runtime_local_identity_connections SET closed=1').run().changes,
        )
      })
      expect(() => cap.finalCheck()).toThrow()
      expect(changes).toBe(1)
      expect(f.database.prepare('SELECT closed FROM runtime_local_identity_connections').get()?.closed).toBe(
        1,
      )
      f.database.exec('ROLLBACK')
      expect(f.database.prepare('SELECT closed FROM runtime_local_identity_connections').get()?.closed).toBe(
        0,
      )
      cap.finalCheck()
    } finally {
      identity.close()
      f.close()
    }
  })
  it('rejects deleted original claims at the last clock and does not reissue on recovery', async () => {
    const f = fixture()
    const identity = createLocalDeploymentIdentity(f.options)
    try {
      const c = await identity.connect(new AbortController().signal)
      const ctx = c.issue('2026-10-04T00:01:00Z', 'trace')
      const cap = identity.capture(ctx)
      let changes = 0
      f.clock(() => {
        f.clock()
        changes = Number(f.database.prepare('DELETE FROM runtime_local_identity_claims').run().changes)
      })
      expect(() => cap.finalCheck()).toThrow()
      expect(changes).toBe(1)
      identity.close()
      const before = f.database.prepare('SELECT total_changes() AS n').get()?.n
      expect(() => createLocalDeploymentIdentity(f.options)).toThrow(/incomplete/)
      expect(f.database.prepare('SELECT total_changes() AS n').get()?.n).toBe(before)
    } finally {
      identity.close()
      f.close()
    }
  })
  it('restores only complete original tables and creates a fresh process connection', async () => {
    const f = fixture()
    const first = createLocalDeploymentIdentity(f.options)
    const original = await first.connect(new AbortController().signal)
    const ctx = original.issue('2026-10-04T00:01:00Z', 'trace')
    first.close()
    f.database.close()
    const freshDatabase = new DatabaseSync(f.file)
    const restoredOptions = {
      ...f.options,
      database: freshDatabase,
      owner: captureLocalDeploymentOwner({
        database: freshDatabase,
        deploymentDirectory: f.deploymentDirectory,
      }),
    }
    const next = createLocalDeploymentIdentity(restoredOptions)
    try {
      expect(() => next.capture(ctx)).toThrow()
      const fresh = await next.connect(new AbortController().signal)
      expect(fresh.actor.authorizationRef).not.toBe(original.actor.authorizationRef)
      next.capture(fresh.issue('2026-10-04T00:01:00Z', 'fresh')).finalCheck()
      next.close()
      freshDatabase.exec('DROP TABLE runtime_local_identity_claims')
      expect(() => createLocalDeploymentIdentity(restoredOptions)).toThrow()
      expect(
        freshDatabase
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='runtime_local_identity_claims'")
          .get()?.n,
      ).toBe(0)
    } finally {
      next.close()
      freshDatabase.close()
      f.close()
    }
  })
  it('rejects original signal abort at the final clock and persisted installation revocation', async () => {
    const f = fixture()
    const identity = createLocalDeploymentIdentity(f.options)
    try {
      const controller = new AbortController()
      const connection = await identity.connect(controller.signal)
      const context = connection.issue('2026-10-04T00:01:00Z', 'trace')
      const cap = identity.capture(context)
      f.clock(() => {
        f.clock()
        controller.abort()
      })
      expect(() => cap.finalCheck()).toThrow()
      const second = await identity.connect(new AbortController().signal)
      const secondContext = second.issue('2026-10-04T00:01:00Z', 'second')
      const secondCap = identity.capture(secondContext)
      identity.revoke()
      expect(() => secondCap.finalCheck()).toThrow()
      expect(() => identity.capture(secondContext)).toThrow()
      const count = f.database.prepare('SELECT count(*) AS n FROM runtime_identity_instances').get()?.n
      await expect(identity.connect(new AbortController().signal)).rejects.toThrow()
      expect(f.database.prepare('SELECT count(*) AS n FROM runtime_identity_instances').get()?.n).toBe(count)
    } finally {
      identity.close()
      f.close()
    }
  })
})
