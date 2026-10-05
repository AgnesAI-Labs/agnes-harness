import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { subagentCollectTool, subagentForkTool, subagentSpawnTool } from '@agnes/base'
import {
  CoreError,
  canonicalJson,
  createWorkspaceInvocationPort,
  hasChildControl,
  Kernel,
  KernelChildren,
  presetDefaults,
  reserveSessionConfiguration,
  scanAll,
  sha256Hex,
} from '@agnes/core'
import {
  fakeProvider,
  fakeSeams,
  fencedFs,
  noTimers,
  testFsPolicy,
  textTurn,
  toolTurn,
} from '@agnes/core/testkit'
import { assertRuntimeRecord, type JsonValue } from '@agnes/jev-runtime'
import type { Provider } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteStorage, type SqliteStorage } from '../src/adapters/storage-sqlite.js'
import { comparisonPayloadDigest } from '../src/runtime/comparison-config-admission.js'
import { createJevChildRefusalReader } from '../src/runtime/jev-child-refusal.js'
import type { JevLoopOptions } from '../src/runtime/jev-loop.js'
import { hasPendingOwnerClose, sessionOwnerCloseFinalizer } from '../src/runtime/session-owner-close.js'
import { createTestHost } from '../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const admittedReportFailure = JSON.parse(
  readFileSync(new URL('./fixtures/child-parent-admission-failure.json', import.meta.url), 'utf8'),
) as {
  parentKey: string
  call: { name: string; childKey: string }
  result: { code: string; diagnostic: string }
}
const realDeliveryFailure = JSON.parse(
  readFileSync(new URL('./fixtures/child-parent-delivery.json', import.meta.url), 'utf8'),
) as {
  parentKey: string
  deliveryId: string
  deliveryIdLength: number
  inboxCommandIdMaxLength: number
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const model = () => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'] as Array<'text'>,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native' as const],
  thinkingReplay: 'native' as const,
  contract_id: null,
})
const fsOps = fencedFs(
  {
    read: async () => new Uint8Array(),
    write: async () => undefined,
    list: async () => [],
    stat: async () => ({ kind: 'file' as const, size: 0, mtimeMs: 0 }),
  },
  testFsPolicy('/w'),
)
const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

function childJev(
  select: (index: number) => 'ACT' | 'RESPOND' = () => 'RESPOND',
  action: (index: number) => string = () => 'write',
): JevLoopOptions {
  let index = 0
  return {
    decision: {
      backend: 'jev',
      endpoint: 'https://jev.invalid/v1',
      model: 'jev-test',
      transport: {
        async invoke({ questions }) {
          const ordinal = index++
          const purpose = select(ordinal)
          const answers: Record<string, JsonValue> = {}
          for (const [name, question] of Object.entries(questions)) {
            const criteria = (question as { criteria?: Record<string, unknown> }).criteria
            if (!criteria) continue
            const choice =
              name === 'purpose'
                ? purpose
                : name.startsWith('operation_')
                  ? name === 'operation_ACT'
                    ? action(ordinal)
                    : 'RESPOND'
                  : name.startsWith('binding_')
                    ? 'LLM_PARAMETERS'
                    : undefined
            if (!choice) continue
            answers[name] = {
              type: 'choice',
              choice,
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
              ),
            }
          }
          return { output: { answers }, observedModel: 'jev-test' }
        },
      },
    },
  }
}

const jevChildrenPreset = {
  name: 'children',
  extends: 'base',
  model: { route: { primary: 'gw' }, id: { primary: 'm1' } },
  subagent: {
    max_depth: 2,
    max_fan_out: 4,
    isolation: 'shared',
    budget_inherit: 'aggregate',
    tree_budget_credits: 'unlimited',
  },
}

describe('same-runtime Host child construction', () => {
  it.each(['full', 'workspace', 'deny'] as const)(
    'inherits %s round approvals into Jev child shell without granting yolo or bypassing deny',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'agnes-child-approval-'))
      dirs.push(root)
      const approval = vi.fn(async () => 'rejected' as const)
      const execute = vi.fn(async () => ({ code: 0, stdout: 'child output', stderr: '', truncated: false }))
      const { host } = await createTestHost({
        dataDir: root,
        packageDirs: { '@agnes/base': baseDir },
        provider: Object.assign(
          fakeProvider(
            [toolTurn('shell', { command: 'synthetic-child-command' }), textTurn('child done')],
            '2',
          ),
          { models: () => [fakeModel({ route: 'gw', id: 'm1' })] },
        ),
        presets: { children: jevChildrenPreset },
        allowed: ['base', 'standard', 'children'],
        jev: childJev(
          (index) => (index === 0 ? 'ACT' : 'RESPOND'),
          () => 'shell',
        ),
        approval,
        seams: {
          sandbox: { exec: execute },
          ...(mode === 'deny'
            ? {
                principals: {
                  authorize: async (_actor, _action, resource) => ({
                    decisionId: 'explicit-deny',
                    effect: resource.id === 'shell' ? ('deny' as const) : ('allow' as const),
                    reason: 'test-policy',
                  }),
                },
              }
            : {}),
        },
        disableSessionTitle: true,
      })
      try {
        const parent = await host.createSession({ cwd: root, runtime: 'jevloop', preset: 'children' })
        const original = parent.d.approvalMode
        const handle = await (parent.d.children as KernelChildren).createWithKind('spawn', {
          parent: parent.key,
          cwd: root,
          input: 'child task',
          isolation: 'shared',
        })
        const capture = () => ({ approvalMode: parent.d.approvalMode ?? null })
        const receipt = await reserveSessionConfiguration(
          parent,
          {
            id: 'child-approval',
            commandId: 'child-approval',
            payloadDigest: comparisonPayloadDigest([{ type: 'text', text: 'child task' }]),
            expectedConfigurationDigest: sha256Hex(canonicalJson(capture())),
            approvalMode: mode === 'workspace' ? 'manual' : 'off',
          },
          capture,
          () => undefined,
        )
        const child = host.kernel.get(handle.key)
        if (!child) throw new Error('Missing child')
        const childMode = child.d.approvalMode
        expect(child.yolo).toBe(false)
        expect((await handle.run('child task')).text).toBe('child done')
        const results = await parent.d.log.storage.scan(handle.key, { type: 'tool/result', limit: 10 })
        expect(results).toHaveLength(1)
        expect(results[0]?.data).toMatchObject(
          mode === 'full'
            ? { isError: false }
            : { isError: true, code: mode === 'deny' ? 'AUTHZ_DENIED' : 'APPROVAL_REJECTED' },
        )
        expect(execute).toHaveBeenCalledTimes(mode === 'full' ? 1 : 0)
        expect(approval).toHaveBeenCalledTimes(mode === 'workspace' ? 1 : 0)
        expect(child.d.approvalMode).toBe(childMode)
        expect(child.yolo).toBe(false)
        await receipt.lease.release()
        expect(parent.d.approvalMode).toBe(original)
      } finally {
        await host.close()
      }
    },
  )

  it.each([
    ['native', undefined],
    ['jevloop', undefined],
    ['jevloop', 'full'],
  ] as const)(
    '%s can spawn and naturally close a child under pinned configuration admission (%s)',
    async (runtime, permissionMode) => {
      const root = mkdtempSync(join(tmpdir(), 'agnes-admitted-spawn-'))
      dirs.push(root)
      let requests = 0
      let observeChild = () => {}
      const provider: Provider = {
        models: () => [fakeModel({ route: 'gw', id: 'm1' })],
        async *infer(request, options) {
          observeChild()
          const script =
            requests++ === 0
              ? toolTurn('subagent_spawn', { task: 'CHILD_ADMISSION_TASK', isolation: 'shared' })
              : textTurn('DONE')
          yield* fakeProvider([script], '2').infer(request, options)
        },
      }
      const { host } = await createTestHost({
        dataDir: root,
        packageDirs: { '@agnes/base': baseDir },
        provider,
        presets: { children: jevChildrenPreset },
        allowed: ['base', 'standard', 'children'],
        jev: childJev(
          (index) => (index === 0 ? 'ACT' : 'RESPOND'),
          () => 'subagent_spawn',
        ),
        disableSessionTitle: true,
      })
      const childModes = new Map<
        string,
        { during: string | undefined; session: import('@agnes/core').SessionImpl }
      >()
      observeChild = () => {
        for (const session of host.kernel.sessions.values())
          if (session.d.runtimeOwnerSessionKey && session.executionActive)
            childModes.set(session.key, { during: session.d.approvalMode, session })
      }
      try {
        const parent = await host.createSession({ cwd: root, runtime, preset: 'children' })
        const originalApprovalMode = parent.d.approvalMode
        const prepared = await host.prepareSessionConfiguration(parent.key)
        const content = [{ type: 'text' as const, text: 'SPAWN_ADMISSION' }]
        const receipt = await host.configurationAdmissions.acquire({
          sessionId: parent.key,
          inputId: 'spawn',
          payloadDigest: comparisonPayloadDigest(content),
          prepared,
          ...(permissionMode ? { permissionMode } : {}),
        })
        await host.configurationAdmissions.enqueue(parent.key, receipt.token, {
          commandId: 'spawn',
          content,
          actor: parent.d.actor,
        })
        await host.configurationAdmissions.check(parent.key, receipt.token, true)
        const result = await host.configurationAdmissions.run(parent.key, receipt.token, {
          until: 'turn-end',
          signal: new AbortController().signal,
        })
        expect(result.reason).toBe('completed')
        const results = await parent.scan({ type: 'tool/result', limit: 10 })
        expect(results).toHaveLength(1)
        expect(results[0]?.data).toMatchObject({ isError: false })
        const controls = parent.d.log.storage as SqliteStorage
        const tasks = await controls.listByParent(parent.key)
        expect(tasks).toHaveLength(1)
        const child = tasks[0]!
        await vi.waitFor(async () => {
          expect((await controls.lookupByKey(child.childKey))?.state).toBe('completed')
          expect(controls.readSessionOwnerEvidence(child.childKey)?.closed).toBeDefined()
        })
        const observed = childModes.get(child.childKey)
        expect(observed?.during).toBe(permissionMode === 'full' ? 'off' : originalApprovalMode)
        expect(observed?.session.yolo).toBe(false)
        await vi.waitFor(() => expect(observed?.session.d.approvalMode).toBe(originalApprovalMode))
        expect(parent.configurationReserved).toBe(false)
        const outbox = await controls.scan(child.childKey, { type: 'x/core/child-outbox', limit: 10 })
        const settlement = outbox.find((row) => (row.data as { kind?: string }).kind === 'subagent-settled')
        if (!settlement) throw new Error('Missing canonical child settlement outbox')
        await vi.waitFor(async () => {
          const receipts = await parent.scan({ type: 'x/core/child-received', limit: 10 })
          expect(receipts).toHaveLength(1)
          const receipt = receipts[0]?.data as { messageId: string }
          expect(receipts[0]).toMatchObject({
            origin: 'system',
            trust: 'trusted',
            data: {
              senderKey: child.childKey,
              sourceSeq: settlement.seq,
              kind: 'subagent-settled',
              outcome: 'completed',
            },
          })
          const messages = await parent.scan({ type: 'user/message', limit: 10 })
          expect(
            messages.find((row) => (row.data as { itemId?: string }).itemId === receipt.messageId),
          ).toMatchObject({ trust: 'untrusted' })
          expect(parent.latest('inbox')).toMatchObject({ items: [] })
        })
        await vi.waitFor(() => expect(parent.executionActive).toBe(false))
        const members = [parent.key, child.childKey].map((key) => {
          const owner = controls.readSessionOwnerEvidence(key)?.owner
          if (!owner) throw new Error('Missing exact owner evidence')
          return owner
        })
        const idle = await host.sessionIdleGates.acquire({ members })
        try {
          await host.sessionIdleGates.check(idle.token)
          await expect(parent.setPreset(parent.preset)).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
          expect(() =>
            (parent.d.children as KernelChildren).createWithKind('spawn', {
              parent: parent.key,
              cwd: root,
              input: 'FORBIDDEN',
            }),
          ).toThrow(/E_LANE_BUSY/)
          await expect(parent.resume()).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
        } finally {
          await host.sessionIdleGates.release(idle.token)
        }
      } finally {
        await host.close()
      }
    },
  )

  it.each(['host-refusal', 'external-result'] as const)(
    'Jev keeps %s provenance when deciding whether an unattended child report requires approval',
    async (firstOutcome) => {
      const captured = JSON.parse(
        readFileSync(new URL('./fixtures/jev-real-prepare-refusal.json', import.meta.url), 'utf8'),
      )
      expect(captured.shell.outcome).toMatchObject({
        error: { code: 'APPROVAL_REJECTED' },
        effect: 'not_applied',
        effectEvidence: { phase: 'not_sent' },
        snapshot: { value: { projection: { trust: 'untrusted' } } },
      })
      expect(captured.sendMessage).toMatchObject({
        resolvedPolicy: { requiresApproval: 'never' },
        outcome: { error: { code: 'APPROVAL_REJECTED' } },
      })
      const root = mkdtempSync(join(tmpdir(), 'agnes-prepare-refusal-'))
      dirs.push(root)
      writeFileSync(join(root, 'result.txt'), 'actual external tool result\n')
      let parentKey = ''
      let childCalls = 0
      let shellExecutions = 0
      const approvalNames: string[] = []
      const provider: Provider = {
        models: () => [fakeModel({ route: 'gw', id: 'm1' })],
        async *infer(request, options) {
          const isChild = JSON.stringify(request.messages).includes('CHILD_PREPARE_TASK')
          const ordinal = isChild ? childCalls++ : -1
          const script =
            ordinal === 0
              ? toolTurn('shell', { command: 'read-local-fixture' })
              : ordinal === 1
                ? toolTurn('subagent_send_message', { childKey: parentKey, message: 'REPORT' })
                : textTurn(isChild ? 'CHILD_DONE' : 'PARENT_RECEIVED')
          yield* fakeProvider([script], '2').infer(request, options)
        },
      }
      const { host } = await createTestHost({
        dataDir: root,
        packageDirs: { '@agnes/base': baseDir },
        provider,
        presets: { children: jevChildrenPreset },
        allowed: ['base', 'standard', 'children'],
        jev: childJev(
          (index) => (index < 2 ? 'ACT' : 'RESPOND'),
          (index) => (index === 0 ? 'shell' : 'subagent_send_message'),
        ),
        approval: async (request) => {
          approvalNames.push(request.tool?.name ?? request.kind)
          return request.tool?.name === 'shell' && firstOutcome === 'external-result'
            ? 'allowed-once'
            : 'rejected'
        },
        seams: {
          sandbox: {
            exec: async () => {
              shellExecutions++
              return {
                code: 0,
                stdout: readFileSync(join(root, 'result.txt'), 'utf8'),
                stderr: '',
                truncated: false,
              }
            },
          },
        },
        disableSessionTitle: true,
      })
      try {
        const parent = await host.createSession({ cwd: root, runtime: 'jevloop', preset: 'children' })
        parentKey = parent.key
        const handle = await parent.d.children.createWithKind?.('spawn', {
          parent: parent.key,
          cwd: root,
          input: 'CHILD_PREPARE_TASK',
          isolation: 'shared',
        })
        if (!handle) throw new Error('Missing child')
        expect(await handle.run('CHILD_PREPARE_TASK')).toMatchObject({ text: 'CHILD_DONE' })
        const results = await parent.d.log.storage.scan(handle.key, { type: 'tool/result', limit: 10 })
        expect(results).toHaveLength(2)
        if (firstOutcome === 'host-refusal') {
          expect(approvalNames).toEqual(['shell'])
          expect(shellExecutions).toBe(0)
          expect(results[0]).toMatchObject({
            trust: 'trusted',
            data: { isError: true, code: 'APPROVAL_REJECTED' },
          })
          expect(results[1]?.data).toMatchObject({ isError: false })
          expect(
            (await parent.scan({ type: 'x/core/child-received', limit: 10 })).map(
              (row) => (row.data as { kind: string }).kind,
            ),
          ).toEqual(['agent-message', 'subagent-settled'])
        } else {
          expect(approvalNames).toEqual(['shell', 'subagent_send_message'])
          expect(shellExecutions).toBe(1)
          expect(results[0]).toMatchObject({ trust: 'untrusted', data: { isError: false } })
          expect(results[1]?.data).toMatchObject({ isError: true, code: 'APPROVAL_REJECTED' })
          expect(
            (await parent.scan({ type: 'x/core/child-received', limit: 10 })).map(
              (row) => (row.data as { kind: string }).kind,
            ),
          ).toEqual(['subagent-settled'])
        }
      } finally {
        await host.close()
      }
    },
    5000,
  )

  it.each(['retry', 'replacement'] as const)('fences an owner finalizer across unbind %s', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-owner-unbind-'))
    dirs.push(root)
    const file = join(root, 'sessions.db')
    const storage = createSqliteStorage({ file })
    const k = kernel(storage, fakeProvider([]))
    const session = await k.session('unbind-owner', {
      ...workspaceSessionOptions('unbind-owner'),
      actor,
      resolvedProfileHash: 'h1',
      cwd: '/w',
      writerRunId: 'first',
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let fail = true
    const finalize = sessionOwnerCloseFinalizer(session, storage, async () => {
      if (mode === 'replacement') await gate
      else if (fail) throw new Error('unbind failed')
    })
    try {
      await session.close()
      if (mode === 'retry') {
        await expect(finalize()).rejects.toThrow('unbind failed')
        expect(hasPendingOwnerClose(session)).toBe(true)
        expect(storage.readSessionOwnerEvidence(session.key)?.closed).toBeUndefined()
        fail = false
        await finalize()
        expect(hasPendingOwnerClose(session)).toBe(false)
        expect(storage.readSessionOwnerEvidence(session.key)?.closed).toEqual({ finalSeq: session.lastSeq })
      } else {
        const closing = finalize()
        expect(hasPendingOwnerClose(session)).toBe(true)
        const replacement = createSqliteStorage({ file })
        try {
          const acquisition = await replacement.open(session.key, { writerRunId: 'second', ttlMs: 1000 })
          release()
          await expect(closing).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
          expect(storage.readSessionOwnerEvidence(session.key)).toEqual({
            owner: {
              sessionKey: session.key,
              writerRunId: 'second',
              ownerEpoch: acquisition.ownerEpoch,
            },
          })
          expect(hasPendingOwnerClose(session)).toBe(true)
          await replacement.release(session.key, 'second')
          await expect(finalize()).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
          expect(storage.readSessionOwnerEvidence(session.key)?.closed).toBeUndefined()
        } finally {
          await replacement.close()
        }
      }
    } finally {
      release()
      await k.close()
    }
  })

  it('never confirms owner closure after a sealed resource drain failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-owner-unknown-'))
    dirs.push(root)
    const { host } = await createTestHost({ dataDir: root, disableSessionTitle: true })
    let key = ''
    try {
      const session = await host.createSession({ cwd: root })
      key = session.key
      session.d.toolQuestionsDrain = async () => {
        throw new Error('resource drain failed')
      }
      await expect(session.close()).rejects.toThrow('failed')
      expect(session.d.log.isClosed).toBe(true)
      expect((session.d.log.storage as SqliteStorage).readSessionOwnerEvidence(key)?.closed).toBeUndefined()
    } finally {
      await host.close()
    }
    const storage = createSqliteStorage({ file: join(root, 'sessions.db') })
    try {
      expect(storage.readSessionOwnerEvidence(key)?.owner).toBeDefined()
      expect(storage.readSessionOwnerEvidence(key)?.closed).toBeUndefined()
    } finally {
      await storage.close()
    }
  })

  it.each(['native', 'jevloop'] as const)(
    '%s retains natural child close proof across raw reopen and retries a failed Host close receipt',
    async (runtime) => {
      const root = mkdtempSync(join(tmpdir(), 'agnes-owner-proof-'))
      dirs.push(root)
      const { host } = await createTestHost({
        dataDir: root,
        packageDirs: { '@agnes/base': baseDir },
        provider: {
          models: () => [fakeModel({ route: 'gw', id: 'm1' })],
          async *infer(request, options) {
            yield* fakeProvider([textTurn('DONE')], '2').infer(request, options)
          },
        },
        presets: { children: jevChildrenPreset },
        allowed: ['base', 'standard', 'children'],
        jev: childJev(),
        disableSessionTitle: true,
      })
      let parentKey = ''
      let childKey = ''
      let childFinalSeq = 0
      try {
        const parent = await host.createSession({ cwd: root, runtime, preset: 'children' })
        parentKey = parent.key
        const storage = parent.d.log.storage as SqliteStorage
        const handle = await parent.d.children.createWithKind?.('spawn', {
          parent: parent.key,
          cwd: root,
          input: 'CHILD_DONE',
          isolation: 'shared',
        })
        if (!handle) throw new Error('Missing child')
        childKey = handle.key
        const child = host.kernel.get(childKey)
        if (!child) throw new Error('Missing child owner')
        const original = storage.readSessionOwnerEvidence(childKey)
        expect(original?.owner.ownerEpoch).toBe(child.d.log.ownerEpoch)
        expect(original?.closed).toBeUndefined()
        await handle.run('CHILD_DONE')
        await vi.waitFor(() => expect(host.kernel.get(childKey)).toBeUndefined())
        childFinalSeq = child.lastSeq
        expect(storage.readSessionOwnerEvidence(childKey)).toEqual({
          owner: original?.owner,
          closed: { finalSeq: childFinalSeq },
        })
        const reopened = await host.createSession({ key: childKey, cwd: root, runtime, preset: 'children' })
        expect(reopened.d.log.ownerEpoch).toBeGreaterThan(original?.owner.ownerEpoch ?? 0)
        expect(storage.readSessionOwnerEvidence(childKey)?.closed).toBeUndefined()
        await child.close() // old successful close is a no-op, never stamps the replacement owner
        expect(storage.readSessionOwnerEvidence(childKey)?.closed).toBeUndefined()
        await reopened.close()
        childFinalSeq = reopened.lastSeq
        expect(storage.readSessionOwnerEvidence(childKey)?.closed).toEqual({ finalSeq: childFinalSeq })
        const record = storage.recordSessionOwnerClosed.bind(storage)
        const fail = vi.spyOn(storage, 'recordSessionOwnerClosed').mockImplementationOnce(async () => {
          throw new Error('receipt unavailable')
        })
        await expect(host.close()).rejects.toThrow('undrained session writers')
        expect(host.kernel.get(parentKey)).toBe(parent)
        expect(parent.d.log.isClosed).toBe(true)
        expect(storage.readSessionOwnerEvidence(parentKey)?.closed).toBeUndefined()
        fail.mockImplementation(record)
        await host.close()
      } finally {
        await host.close()
      }
      const reopenedStore = createSqliteStorage({ file: join(root, 'sessions.db') })
      try {
        const tree = await reopenedStore.inspectSessionTree(parentKey)
        expect(tree.ownerEvidence).toHaveLength(2)
        expect(tree.ownerEvidence.every((item) => item.evidence?.closed !== undefined)).toBe(true)
        expect(reopenedStore.readSessionOwnerEvidence(childKey)?.closed).toEqual({ finalSeq: childFinalSeq })
      } finally {
        await reopenedStore.close()
      }
    },
  )

  it.each(['native', 'jevloop'] as const)(
    '%s keeps a naturally idle child alive until its real SQLite descendant reports and drains',
    async (runtime) => {
      const root = mkdtempSync(join(tmpdir(), 'agnes-grand-report-'))
      dirs.push(root)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let waiting = false
      const provider: Provider = {
        models: () => [fakeModel({ route: 'gw', id: 'm1' })],
        async *infer(request, options) {
          const messages = JSON.stringify(request.messages)
          let text = 'ROOT_RECEIVED_CHILD'
          if (messages.includes('GRAND_WORK')) {
            await gate
            text = 'GRAND_DONE'
          } else if (messages.includes('CHILD_WAIT')) {
            const received = messages.includes('Background subagent')
            text = received ? 'CHILD_FINISHED_AFTER_GRAND' : 'WAITING_FOR_GRAND'
            waiting ||= !received
          }
          yield* fakeProvider([textTurn(text)], '2').infer(request, options)
        },
      }
      const { host } = await createTestHost({
        dataDir: root,
        packageDirs: { '@agnes/base': baseDir },
        provider,
        presets: { children: jevChildrenPreset },
        allowed: ['base', 'standard', 'children'],
        jev: childJev(),
        disableSessionTitle: true,
      })
      try {
        const parent = await host.createSession({ cwd: root, runtime, preset: 'children' })
        const handle = await parent.d.children.createWithKind?.('spawn', {
          parent: parent.key,
          cwd: root,
          input: 'CHILD_WAIT',
          isolation: 'shared',
        })
        if (!handle) throw new Error('Missing child')
        const child = host.kernel.get(handle.key)
        if (!child) throw new Error('Missing child owner')
        const grand = await child.d.children.createWithKind?.('spawn', {
          parent: child.key,
          cwd: root,
          input: 'GRAND_WORK',
          isolation: 'shared',
        })
        if (!grand) throw new Error('Missing grandchild')
        const grandRun = grand.run('GRAND_WORK')
        const childRun = handle.run('CHILD_WAIT')
        await vi.waitFor(() => expect(waiting).toBe(true))
        expect((await parent.d.children.inspect?.(child.key))?.state).toBe('running')
        expect((await child.d.children.inspect?.(grand.key))?.state).toBe('running')
        expect(await parent.scan({ type: 'x/core/child-received', limit: 10 })).toEqual([])
        release()
        expect(await grandRun).toMatchObject({ text: 'GRAND_DONE' })
        expect(await childRun).toMatchObject({ text: 'CHILD_FINISHED_AFTER_GRAND' })
        expect((await child.d.children.inspect?.(grand.key))?.state).toBe('done')
        expect((await parent.d.children.inspect?.(child.key))?.state).toBe('done')
        expect(
          (await parent.d.log.storage.scan(child.key, { type: 'x/core/child-received', limit: 10 }))[0]?.data,
        ).toMatchObject({ senderKey: grand.key, outcome: 'completed' })
        await vi.waitFor(() => expect(parent.executionActive).toBe(false))
        await vi.waitFor(async () =>
          expect(await parent.scan({ type: 'assistant/message', limit: 10 })).toHaveLength(1),
        )
      } finally {
        release()
        await host.close()
      }
    },
    5000,
  )

  it.each([
    ['native', 'idle'],
    ['jevloop', 'idle'],
    ['native', 'collect'],
    ['jevloop', 'collect'],
    ['jevloop', 'admitted'],
  ] as const)(
    '%s delivers a real child tool message and settlement to a %s parent without a second user input',
    async (runtime, parentMode) => {
      const root = mkdtempSync(join(tmpdir(), 'agnes-child-report-'))
      dirs.push(root)
      let parentKey = ''
      let childKey = ''
      let childCalls = 0
      let collected = false
      let releaseChild!: () => void
      const childGate = new Promise<void>((resolve) => {
        releaseChild = resolve
      })
      if (parentMode === 'idle') releaseChild()
      const requests: string[] = []
      const provider: Provider = {
        models: () => [fakeModel({ route: 'gw', id: 'm1' })],
        async *infer(request, options) {
          const messages = JSON.stringify(request.messages)
          requests.push(messages)
          if (messages.includes('CHILD_REPORT_TASK')) await childGate
          let script = textTurn(messages.includes('RESULT_X') ? 'PARENT_RECEIVED_RESULT_X' : 'WAITING')
          if (messages.includes('CHILD_REPORT_TASK')) {
            script =
              childCalls++ === 0
                ? toolTurn(
                    parentMode === 'admitted' ? admittedReportFailure.call.name : 'subagent_send_message',
                    { childKey: parentKey, message: 'RESULT_X' },
                  )
                : textTurn('CHILD_DONE')
          } else if (messages.includes('COLLECT_CHILD') && !collected) {
            collected = true
            script = toolTurn('subagent_collect', { childKey, wait: true })
          }
          yield* fakeProvider([script], '2').infer(request, options)
        },
      }
      const { host } = await createTestHost({
        dataDir: root,
        packageDirs: { '@agnes/base': baseDir },
        provider,
        presets: { children: jevChildrenPreset },
        allowed: ['base', 'standard', 'children'],
        jev: childJev(
          (index) => (index === 1 || (parentMode === 'collect' && index === 2) ? 'ACT' : 'RESPOND'),
          (index) => (index === 2 && parentMode === 'collect' ? 'subagent_collect' : 'subagent_send_message'),
        ),
        approval: async () => 'allowed-once',
        disableSessionTitle: true,
      })
      try {
        const parent = await host.createSession({
          cwd: root,
          runtime,
          preset: 'children',
          ...(runtime === 'native'
            ? { key: realDeliveryFailure.parentKey }
            : parentMode === 'admitted'
              ? { key: admittedReportFailure.parentKey }
              : {}),
        })
        parentKey = parent.key
        await parent.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'Wait for report' }] })
        expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'completed',
        )
        const handle = await parent.d.children.createWithKind?.('spawn', {
          parent: parent.key,
          cwd: root,
          input: 'CHILD_REPORT_TASK',
          isolation: 'shared',
        })
        if (!handle) throw new Error('Missing child')
        const child = host.kernel.get(handle.key)
        if (!child) throw new Error('Missing child owner')
        childKey = child.key
        const childRun = handle.run('CHILD_REPORT_TASK')
        let parentRun: ReturnType<typeof parent.run> | undefined
        if (parentMode === 'admitted') {
          expect(parent.key).toBe(admittedReportFailure.call.childKey)
          expect(admittedReportFailure.result).toMatchObject({
            code: 'TOOL_OUTCOME_UNKNOWN',
            diagnostic: 'CoreError: E_LANE_BUSY: Session configuration is reserved for admitted work',
          })
          await vi.waitFor(() =>
            expect(requests.some((request) => request.includes('CHILD_REPORT_TASK'))).toBe(true),
          )
          const prepared = await host.prepareSessionConfiguration(parent.key)
          const content = [{ type: 'text' as const, text: 'ADMITTED_PARENT_REPORT' }]
          const admission = await host.configurationAdmissions.acquire({
            sessionId: parent.key,
            inputId: 'report-admission',
            payloadDigest: comparisonPayloadDigest(content),
            prepared,
          })
          await host.configurationAdmissions.enqueue(parent.key, admission.token, {
            commandId: 'report-admission',
            content,
            actor,
          })
          await host.configurationAdmissions.check(parent.key, admission.token, true)
          releaseChild()
          await vi.waitFor(async () => {
            const rows = await parent.d.log.storage.scan(child.key, { type: 'tool/result', limit: 10 })
            expect(rows).toHaveLength(1)
            expect(rows[0]?.data).toMatchObject({ isError: false })
            expect(parent.configurationReserved).toBe(true)
          })
          parentRun = host.configurationAdmissions.run(parent.key, admission.token, {
            until: 'turn-end',
            signal: new AbortController().signal,
          }) as ReturnType<typeof parent.run>
        }
        if (parentMode === 'collect') {
          await vi.waitFor(() =>
            expect(requests.some((request) => request.includes('CHILD_REPORT_TASK'))).toBe(true),
          )
          await parent.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'COLLECT_CHILD' }] })
          parentRun = parent.run({ until: 'turn-end', signal: new AbortController().signal })
          await vi.waitFor(async () =>
            expect(
              (await parent.scan({ type: 'tool/call', limit: 10 })).some(
                (row) => (row.data as { name: string }).name === 'subagent_collect',
              ),
            ).toBe(true),
          )
          releaseChild()
        }
        expect((await childRun).text).toBe('CHILD_DONE')
        if (parentRun) expect((await parentRun).reason).toBe('completed')
        await vi.waitFor(async () => {
          const received = await parent.scan({ type: 'x/core/child-received', limit: 10 })
          expect(received).toHaveLength(2)
          expect((parent.latest('inbox') as { items: unknown[] }).items).toEqual([])
          expect(parent.executionActive).toBe(false)
        })
        const received = await parent.scan({ type: 'x/core/child-received', limit: 10 })
        expect(received.map((row) => row.data)).toEqual([
          expect.objectContaining({ senderKey: child.key, kind: 'agent-message' }),
          expect.objectContaining({ senderKey: child.key, kind: 'subagent-settled', outcome: 'completed' }),
        ])
        const calls = await parent.d.log.storage.scan(child.key, { type: 'tool/result', limit: 10 })
        expect(calls).toHaveLength(1)
        expect(calls[0]?.data).toMatchObject({ isError: false })
        if (runtime === 'native') {
          expect(realDeliveryFailure.deliveryId.length).toBe(realDeliveryFailure.deliveryIdLength)
          expect(realDeliveryFailure.deliveryIdLength).toBeGreaterThan(
            realDeliveryFailure.inboxCommandIdMaxLength,
          )
          const outbox = await parent.d.log.storage.scan(child.key, {
            type: 'x/core/child-outbox',
            limit: 10,
          })
          const actual = outbox.find((row) => (row.data as { kind: string }).kind === 'agent-message')
          if (!actual) throw new Error('Missing real child message outbox')
          expect((actual.data as { deliveryId: string }).deliveryId.length).toBe(137)
        }
        const messages = await parent.scan({ type: 'user/message', limit: 10 })
        expect(messages.filter((row) => row.trust === 'untrusted')).toHaveLength(2)
        expect(requests.some((request) => request.includes('Agent ') && request.includes('RESULT_X'))).toBe(
          true,
        )
        const replies = await parent.scan({ type: 'assistant/message', limit: 10 })
        expect(JSON.stringify(replies)).toContain('PARENT_RECEIVED_RESULT_X')
        expect(host.kernel.get(child.key)).toBeUndefined()
      } finally {
        releaseChild()
        await host.close()
      }
    },
    5000,
  )

  it.each([
    ['native', 'shared'],
    ['jevloop', 'shared'],
    ['native', 'worktree'],
    ['jevloop', 'worktree'],
  ] as const)(
    'cold-continues a completed %s/%s spawn with new input on its original ledger',
    async (runtime, isolation) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-child-continue-')))
      dirs.push(root)
      if (isolation === 'worktree') {
        execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' })
        writeFileSync(join(root, '.gitignore'), '.worktrees\n')
        writeFileSync(join(root, 'README.md'), 'root\n')
        execFileSync('git', ['add', '.'], { cwd: root })
        execFileSync(
          'git',
          ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'],
          { cwd: root, stdio: 'pipe' },
        )
      }
      const setup = async (answer: string) => {
        const provider = Object.assign(
          fakeProvider(
            isolation === 'worktree'
              ? [toolTurn('write', { path: `${answer}.txt`, content: answer }), textTurn(answer)]
              : [textTurn(answer)],
            '2',
          ),
          {
            models: () => [fakeModel({ route: 'gw', id: 'm1' })],
          },
        )
        const built = await createTestHost({
          dataDir: root,
          packageDirs: { '@agnes/base': baseDir },
          ...(isolation === 'worktree'
            ? {
                seams: {
                  sandbox: {
                    exec: async (argv: string[], options: { cwd: string }) => {
                      try {
                        return {
                          code: 0,
                          stdout: execFileSync(argv[0] as string, argv.slice(1), {
                            cwd: options.cwd,
                            encoding: 'utf8',
                            stdio: ['ignore', 'pipe', 'pipe'],
                          }),
                          stderr: '',
                          truncated: false,
                        }
                      } catch (error) {
                        const failure = error as { status?: number; stdout?: string; stderr?: string }
                        return {
                          code: failure.status ?? 1,
                          stdout: failure.stdout ?? '',
                          stderr: failure.stderr ?? '',
                          truncated: false,
                        }
                      }
                    },
                  },
                },
              }
            : {}),
          provider,
          presets: { children: jevChildrenPreset },
          allowed: ['base', 'standard', 'children'],
          jev: childJev((index) => (isolation === 'worktree' && index === 0 ? 'ACT' : 'RESPOND')),
          approval: async () => 'allowed-once',
          disableSessionTitle: true,
        })
        const parent = await built.host.createSession({ cwd: root, runtime, preset: 'children' })
        return { ...built, parent, provider }
      }
      const first = await setup('FIRST_CHILD_RESULT')
      let childKey = ''
      let originalTree: { rootTaskId: string; ancestorScopeIds: string[] } | undefined
      try {
        const factory = first.parent.d.children
        if (!(factory instanceof KernelChildren)) throw new Error('Missing default factory')
        const child = await factory.createWithKind('spawn', {
          parent: first.parent.key,
          cwd: root,
          input: 'INITIAL_CHILD_INPUT',
          isolation,
          ...(isolation === 'worktree' ? { start: false } : {}),
        })
        childKey = child.key
        if (isolation === 'worktree') {
          const path = join(root, '.worktrees', 'child-fixture')
          execFileSync('git', ['worktree', 'add', '-b', 'agnes/subagent-fixture', path, 'HEAD'], {
            cwd: root,
            stdio: 'pipe',
          })
          if (!hasChildControl(first.parent.d.log.storage)) throw new Error('Missing storage')
          const record = await first.parent.d.log.storage.lookupByKey(childKey)
          if (!record?.workspaceId) throw new Error('Missing workspace')
          await first.parent.d.log.storage.updateWorkspace?.(record.workspaceId, {
            path,
            root,
            branch: 'agnes/subagent-fixture',
            phase: 'attached',
          })
        }
        const result = await child.run('INITIAL_CHILD_INPUT')
        expect(result).toMatchObject({ text: 'FIRST_CHILD_RESULT' })
        expect(await factory.inspect(childKey)).toMatchObject({ state: 'done' })
        if (!hasChildControl(first.parent.d.log.storage)) throw new Error('Missing storage')
        const firstRecord = await first.parent.d.log.storage.lookupByKey(childKey)
        if (!firstRecord) throw new Error('Missing child')
        originalTree = {
          rootTaskId: firstRecord.rootTaskId,
          ancestorScopeIds: [...firstRecord.ancestorScopeIds],
        }

        if (isolation === 'worktree') {
          expect(
            readFileSync(join(root, '.worktrees', 'child-fixture', 'FIRST_CHILD_RESULT.txt'), 'utf8'),
          ).toBe('FIRST_CHILD_RESULT')
          expect(existsSync(join(root, 'FIRST_CHILD_RESULT.txt'))).toBe(false)
        }
      } finally {
        await first.host.close()
      }
      const second = await setup('SECOND_CHILD_RESULT')
      try {
        const factory = second.parent.d.children
        if (!(factory instanceof KernelChildren)) throw new Error('Missing default factory')
        expect(factory.get(childKey)).toBeUndefined()
        const receipt = await factory.sendMessage(childKey, 'NEW_CHILD_INPUT', {
          deliveryId: 'followup-real-ledger',
          parentEffectId: 'parent-local-tool',
          signal: new AbortController().signal,
        })
        expect(receipt).toMatchObject({
          childKey,
          messageId: expect.any(String),
          acceptedSeq: expect.any(Number),
        })
        await vi.waitFor(async () =>
          expect(await factory.inspect(childKey)).toMatchObject({
            state: 'done',
            text: 'SECOND_CHILD_RESULT',
          }),
        )
        const rows = await second.parent.d.log.storage.scan(childKey, { fromSeq: 1, limit: 1000 })
        const messages = rows
          .filter((row) => row.type === 'user/message')
          .map((row) =>
            (row.data as { content: Array<{ text?: string }> }).content
              .map((block) => block.text ?? '')
              .join(''),
          )
        expect(messages).toEqual(['INITIAL_CHILD_INPUT', 'NEW_CHILD_INPUT'])
        expect(rows.filter((row) => row.type === 'x/core/child-descriptor')).toHaveLength(1)
        expect(rows.filter((row) => row.type === 'session/start')).toHaveLength(1)
        expect(
          await factory.sendMessage(childKey, 'NEW_CHILD_INPUT', {
            deliveryId: 'followup-real-ledger',
            parentEffectId: 'parent-local-tool',
            signal: new AbortController().signal,
          }),
        ).toEqual(receipt)
        await expect(
          factory.sendMessage(childKey, 'CONFLICTING_INPUT', {
            deliveryId: 'followup-real-ledger',
            parentEffectId: 'parent-local-tool',
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: 'E_CHILD_CONFLICT' })
        if (!hasChildControl(second.parent.d.log.storage)) throw new Error('Missing child storage')
        const record = await second.parent.d.log.storage.lookupByKey(childKey)
        expect(record?.rootTaskId).toBe(originalTree?.rootTaskId)
        expect(record?.ancestorScopeIds).toEqual(originalTree?.ancestorScopeIds)

        if (!record) throw new Error('Missing durable child')
        const originalRoot = record.rootTaskId
        const originalScopes = [...record.ancestorScopeIds]
        if (isolation === 'worktree') {
          rmSync(join(root, '.worktrees', 'child-fixture', '.git'))
          await expect(
            factory.sendMessage(childKey, 'REPLACED_WORKTREE', {
              deliveryId: 'untrusted-worktree',
              parentEffectId: 'parent-local-tool',
              signal: new AbortController().signal,
            }),
          ).rejects.toMatchObject({ code: 'E_WORKSPACE_UNTRUSTED' })
          expect(existsSync(join(root, '.worktrees', 'child-fixture', 'SECOND_CHILD_RESULT.txt'))).toBe(true)
        }
        await factory.cancel(childKey)
        const cancelled = await second.parent.d.log.storage.lookupByKey(childKey)
        expect(cancelled?.rootTaskId).toBe(originalRoot)
        expect(cancelled?.ancestorScopeIds).toEqual(originalScopes)
        await expect(
          factory.sendMessage(childKey, 'NO_REVIVAL', {
            deliveryId: 'after-permanent-cancel',
            parentEffectId: 'parent-local-tool',
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
        expect(
          await second.parent.d.log.storage.scan(childKey, { type: 'x/core/child-delivery', limit: 100 }),
        ).toHaveLength(1)

        if (isolation === 'worktree') {
          expect(
            readFileSync(join(root, '.worktrees', 'child-fixture', 'SECOND_CHILD_RESULT.txt'), 'utf8'),
          ).toBe('SECOND_CHILD_RESULT')
          expect(existsSync(join(root, 'SECOND_CHILD_RESULT.txt'))).toBe(false)
        }
      } finally {
        await second.host.close()
      }
    },
  )
  it.each(['fork', 'spawn'] as const)(
    'records a genuine %s model refusal as not applied and accepts the next user turn',
    async (kind) => {
      const captured = JSON.parse(
        readFileSync(
          new URL('../../core/test/fixtures/jev-real-child-model-refusal.json', import.meta.url),
          'utf8',
        ),
      )
      const args = captured.events[0].data.args as { question: string; model: string }
      expect(captured.events[1].data.code).toBe('TOOL_OUTCOME_UNKNOWN')
      expect(captured.events[2].data.reason).toBe('blocked')
      const root = mkdtempSync(join(tmpdir(), 'agnes-jev-child-refusal-'))
      dirs.push(root)
      const name = `subagent_${kind}`
      const provider = Object.assign(
        fakeProvider([
          toolTurn(name, kind === 'fork' ? args : { task: args.question, model: args.model }),
          textTurn('The model override was refused.'),
          textTurn('The next turn can continue.'),
        ]),
        { models: () => [fakeModel({ route: 'gw', id: 'm1' })] },
      )
      const { host } = await createTestHost({
        dataDir: root,
        packageDirs: { '@agnes/base': baseDir },
        provider,
        presets: { children: jevChildrenPreset },
        allowed: ['base', 'standard', 'children'],
        jev: childJev(
          (index) => (index === 0 ? 'ACT' : 'RESPOND'),
          () => name,
        ),
        approval: async () => 'allowed-once',
        disableSessionTitle: true,
      })
      try {
        const parent = await host.createSession({ cwd: root, runtime: 'jevloop', preset: 'children' })
        const factory = parent.d.children
        if (!(factory instanceof KernelChildren)) throw new Error('Missing default factory')
        const invoke = factory.createWithKind.bind(factory)
        let refusal: unknown
        vi.spyOn(factory, 'createWithKind').mockImplementation(async (requestedKind, options) => {
          try {
            return await invoke(requestedKind, options)
          } catch (error) {
            refusal = error
            throw error
          }
        })
        const readRefusal = createJevChildRefusalReader(parent)
        const definition = parent.currentTools().snapshot(parent.lastSeq).byName.get(name)
        if (!definition) throw new Error('Missing child tool')
        await parent.enqueue('next-turn', {
          actor,
          content: [{ type: 'text', text: 'Delegate the captured task.' }],
        })
        expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'completed',
        )
        const rows = await scanAll((query) => parent.scan(query), { toSeq: parent.lastSeq })
        const call = rows.find((row) => row.type === 'tool/call')
        const result = rows.find((row) => row.type === 'tool/result')
        if (!call) throw new Error('Missing child call')
        const { toolUseId } = call.data as { toolUseId: string }
        expect(readRefusal(definition, refusal, toolUseId, call.seq)).toMatchObject({
          code: 'E_MODEL_UNKNOWN',
        })
        expect(readRefusal(definition, refusal, toolUseId, call.seq + 1)).toBeUndefined()
        expect(readRefusal(definition, refusal, `${toolUseId}:other`, call.seq)).toBeUndefined()
        expect(
          readRefusal(definition, new CoreError('E_MODEL_UNKNOWN', 'forged'), toolUseId, call.seq),
        ).toBeUndefined()
        expect(
          readRefusal(
            { ...definition, source: { ...definition.source, source: 'third-party' } },
            refusal,
            toolUseId,
            call.seq,
          ),
        ).toBeUndefined()
        expect(
          readRefusal(
            { ...definition, definitionFingerprint: `${definition.definitionFingerprint}:new` },
            refusal,
            toolUseId,
            call.seq,
          ),
        ).toBeUndefined()
        expect(
          readRefusal(
            { ...definition, meta: { ...definition.meta, replay: 'safe' } },
            refusal,
            toolUseId,
            call.seq,
          ),
        ).toBeUndefined()
        expect(result?.data).toMatchObject({ isError: true, code: 'E_MODEL_UNKNOWN' })
        const records = rows
          .filter((row) => row.type === 'runtime/record')
          .map((row) => {
            const { record } = row.data as { record: unknown }
            assertRuntimeRecord(record)
            return record
          })
        expect(records.find((record) => record.kind === 'action.settled')).toMatchObject({
          outcome: {
            kind: 'error',
            effect: 'not_applied',
            error: { code: 'E_MODEL_UNKNOWN' },
            effectEvidence: {
              phase: 'may_have_sent',
              childCreationRefusal: {
                kind,
                parentKey: parent.key,
                writerRunId: parent.writerRunId,
                lane: parent.lane,
                callSeq: call?.seq,
                code: 'E_MODEL_UNKNOWN',
              },
            },
          },
        })
        if (!hasChildControl(parent.d.log.storage)) throw new Error('Missing child control')
        expect(await parent.d.log.storage.listByParent(parent.key)).toEqual([])
        expect(host.kernel.sessions.size).toBe(1)
        await parent.enqueue('next-turn', {
          actor,
          content: [{ type: 'text', text: 'Continue without a child.' }],
        })
        expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'completed',
        )
        expect((await parent.scan({ type: 'tool/call', limit: 100 })).length).toBe(1)
        expect((await parent.scan({ type: 'assistant/message', limit: 100 })).length).toBe(2)
      } finally {
        await host.close()
      }
    },
  )

  it('keeps a forged preflight code from a storage failure unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-jev-child-refusal-fault-'))
    dirs.push(root)
    const provider = Object.assign(fakeProvider([toolTurn('subagent_fork', { question: 'task' })]), {
      models: () => [fakeModel({ route: 'gw', id: 'm1' })],
    })
    const { host } = await createTestHost({
      dataDir: root,
      packageDirs: { '@agnes/base': baseDir },
      provider,
      presets: { children: jevChildrenPreset },
      allowed: ['base', 'standard', 'children'],
      jev: childJev(
        () => 'ACT',
        () => 'subagent_fork',
      ),
      approval: async () => 'allowed-once',
      disableSessionTitle: true,
    })
    try {
      const parent = await host.createSession({ cwd: root, runtime: 'jevloop', preset: 'children' })
      if (!hasChildControl(parent.d.log.storage)) throw new Error('Missing child control')
      vi.spyOn(parent.d.log.storage, 'nextOrdinal').mockRejectedValueOnce(
        new CoreError('E_MODEL_UNKNOWN', 'forged storage error'),
      )
      await parent.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'Delegate.' }] })
      expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'blocked',
      )
      expect((await parent.scan({ type: 'tool/result', limit: 100 }))[0]?.data).toMatchObject({
        code: 'TOOL_OUTCOME_UNKNOWN',
      })
      const factory = parent.d.children
      expect(factory).toBeInstanceOf(KernelChildren)
      if (!(factory instanceof KernelChildren)) throw new Error('Missing default factory')
      const call = [...parent.state.toolCalls.values()][0]
      expect(
        factory.readCreationRefusal(new CoreError('E_MODEL_UNKNOWN', 'forged'), {
          kind: 'fork',
          toolUseId: 'intent:1',
          callSeq: call?.seq ?? 0,
        }),
      ).toBeUndefined()
    } finally {
      await host.close()
    }
  })
  it.each(['caller', 'owner'] as const)(
    'drains a real Jev provider call through %s cancellation without a replacement writer',
    async (source) => {
      const root = mkdtempSync(join(tmpdir(), 'agnes-jev-child-cancel-'))
      dirs.push(root)
      let entered = false
      let providerAborted = false
      let collectChildKey = ''
      let collectEnabled = false
      let collected = false
      const scripted = fakeProvider([textTurn('usable')])
      const provider: Provider = {
        ...scripted,
        models: () => [fakeModel({ route: 'gw', id: 'm1' })],
        async *infer(request, options) {
          if (entered) {
            if (collectEnabled && !collected) {
              collected = true
              yield* fakeProvider([
                toolTurn('subagent_collect', { childKey: collectChildKey, wait: true }),
              ]).infer(request, options)
              return
            }
            yield* scripted.infer(request, options)
            return
          }
          for await (const event of scripted.infer(request, options)) {
            yield event
            break
          }
          const signal = options?.signal
          if (!signal) throw new Error('Missing provider cancellation signal')
          entered = true
          await new Promise<void>((resolve) => {
            const abort = () => {
              providerAborted = true
              resolve()
            }
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          })
        },
      }
      const { host } = await createTestHost({
        dataDir: root,
        provider,
        packageDirs: { '@agnes/base': baseDir },
        treeBudgetCredits: 100,
        presets: { children: jevChildrenPreset },
        allowed: ['base', 'standard', 'children'],
        jev: childJev(
          (index) => (source === 'caller' && index === 1 ? 'ACT' : 'RESPOND'),
          () => 'subagent_collect',
        ),
        disableSessionTitle: true,
      })
      try {
        const parent = await host.createSession({ cwd: root, runtime: 'jevloop', preset: 'children' })
        const controller = new AbortController()
        const handle = await parent.d.children.createWithKind?.(source === 'caller' ? 'fork' : 'spawn', {
          parent: parent.key,
          cwd: root,
          input: 'wait',
          signal: controller.signal,
        })
        if (!handle) throw new Error('Missing child')
        collectChildKey = handle.key
        const child = host.kernel.get(handle.key)
        if (!child) throw new Error('Missing child writer')
        if (source === 'owner') controller.abort() // A published spawn is independent of this call.
        const running = handle.run('wait', source === 'caller' ? { signal: controller.signal } : undefined)
        const settlement = running.catch((error: unknown) => error)
        await vi.waitFor(() => expect(entered).toBe(true))
        if (source === 'caller') controller.abort()
        else await parent.close()
        expect(await settlement).toBeInstanceOf(Error)
        expect(providerAborted).toBe(true)
        expect(child.d.log.isClosed).toBe(true)
        expect(host.kernel.get(child.key)).toBeUndefined()
        if (!hasChildControl(parent.d.log.storage)) throw new Error('Missing child control')
        expect((await parent.d.log.storage.lookupByKey(child.key))?.state).toBe('cancelled')
        if (source === 'caller') {
          collectEnabled = true
          await parent.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'continue parent' }] })
          expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
            'completed',
          )
          const call = (await parent.scan({ type: 'tool/call', limit: 10 })).find(
            (row) => (row.data as { name?: string }).name === 'subagent_collect',
          )
          const toolUseId = (call?.data as { toolUseId?: string } | undefined)?.toolUseId
          expect(toolUseId).toBeDefined()
          const collect = (await parent.scan({ type: 'tool/result', limit: 10 })).find(
            (row) => (row.data as { toolUseId?: string }).toolUseId === toolUseId,
          )
          expect(collect?.data).toMatchObject({
            isError: false,
            content: [{ type: 'text', text: `child ${child.key}: cancelled` }],
          })
        }
      } finally {
        await host.close()
      }
    },
  )

  it.each([
    ['jevloop', 'fork'],
    ['jevloop', 'spawn'],
    ['native', 'fork'],
    ['native', 'spawn'],
  ] as const)(
    '%s %s gets a separate loop, complete history or a fresh seed, and real scoped tools',
    async (runtime, kind) => {
      const root = mkdtempSync(join(tmpdir(), 'agnes-jev-child-'))
      dirs.push(root)
      const provider = Object.assign(
        fakeProvider(
          [
            textTurn('parent-history'),
            toolTurn('write', { path: 'child.txt', content: 'real child write' }),
            textTurn('child answer'),
          ],
          '2',
        ),
        { models: () => [fakeModel({ route: 'gw', id: 'm1' })] },
      )
      const { host } = await createTestHost({
        dataDir: root,
        packageDirs: { '@agnes/base': baseDir },
        provider,
        treeBudgetCredits: 100,
        presets: { children: jevChildrenPreset },
        allowed: ['base', 'standard', 'children'],
        jev: childJev((index) => (index === 1 ? 'ACT' : 'RESPOND')),
        approval: async () => 'allowed-once',
        disableSessionTitle: true,
      })
      try {
        const parent = await host.createSession({ cwd: root, runtime, preset: 'children' })
        await parent.enqueue('next-turn', {
          actor,
          content: [{ type: 'text', text: 'complete parent turn' }],
        })
        const parentResult = await parent.run({ until: 'turn-end', signal: new AbortController().signal })
        expect(parentResult.reason).toBe('completed')
        const boundary = (await parent.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]?.seq
        expect(boundary).toBeDefined()
        if (boundary === undefined) throw new Error('Missing completed parent boundary')
        if (runtime === 'jevloop')
          expect((await parent.scan({ type: 'x/agnes/jev-tree-ack', limit: 10 })).length).toBeGreaterThan(0)
        await parent.enqueue('next-turn', {
          actor,
          content: [{ type: 'text', text: 'unfinished parent turn' }],
        })
        await parent.acceptInput()
        const factory = parent.d.children
        const handle = await factory.createWithKind?.(kind, {
          parent: parent.key,
          cwd: root,
          input: 'write child file',
          isolation: 'shared',
        })
        if (!handle) throw new Error('Missing child handle')
        const child = host.kernel.get(handle.key)
        if (!child) throw new Error('Missing child session')
        expect(child.runtimeIdentity).toEqual(parent.runtimeIdentity)
        expect(child.generationDepth).toBe(1)
        expect(child.d.runtimeOwnerSessionKey).toBe(parent.key)
        expect((await handle.status()).text).toBeUndefined()
        if (kind === 'fork') {
          expect(child.d.log.parent).toEqual({ key: parent.key, boundarySeq: boundary })
          const inherited = await scanAll((query) => child.scan(query), { toSeq: boundary })
          expect(inherited).toEqual(await scanAll((query) => parent.scan(query), { toSeq: boundary }))
          expect(inherited.filter((row) => row.type === 'turn/start')).toHaveLength(1)
        } else {
          expect(child.d.log.parent).toBeUndefined()
          expect(await child.scan({ type: 'runtime/record', limit: 10 })).toEqual([])
          expect(await child.scan({ type: 'assistant/message', limit: 10 })).toEqual([])
        }
        expect(child.currentTools().snapshot(child.lastSeq).byName.get('write')?.source).toMatchObject({
          trust: 'builtin',
        })
        expect((await handle.run('write child file')).text).toBe('child answer')
        expect(readFileSync(join(root, 'child.txt'), 'utf8')).toBe('real child write')
        const own = await scanAll((query) => parent.d.log.storage.scan(child.key, query), {
          fromSeq: (child.d.log.parent?.boundarySeq ?? 0) + 1,
          toSeq: child.lastSeq,
        })
        expect(
          own
            .filter((row) => row.type === 'assistant/message')
            .flatMap((row) => (row.data as { content: { type: string; text?: string }[] }).content)
            .filter((block) => block.type === 'text')
            .map((block) => block.text),
        ).toEqual(['child answer'])
        if (runtime === 'jevloop')
          expect(own.filter((row) => row.type === 'x/agnes/jev-tree-ack').length).toBeGreaterThan(0)
        if (!hasChildControl(parent.d.log.storage)) throw new Error('Missing child control')
        const stored = await parent.d.log.storage.lookupByKey(child.key)
        expect(stored?.runtime).toEqual(parent.runtimeIdentity)
        expect(stored?.model).toEqual({ route: 'gw', model: 'm1' })
        expect((await parent.d.log.storage.scopeForChild(child.key))?.capMicro).toBeNull()
      } finally {
        await host.close()
      }
    },
  )
})

/** Task 6 makes workspace-domain tools fail closed without a Host-owned invocation boundary. */
function workspaceSessionOptions(sessionKey: string) {
  const seams = fakeSeams()
  const invocation = () =>
    createWorkspaceInvocationPort(() => ({
      source: {
        root: '/w',
        fs: fsOps,
        ready: async () => ({ confine: async (argv) => [...argv] }),
        hookSnapshot: async () => ({ workspaceDigest: 'test', policyRevision: 'test', hooks: [] }),
        hookSandbox: seams.sandbox,
        approval: seams.approval,
        checkpoint: seams.checkpoint,
      },
      release: () => undefined,
    }))
  const workspaceInvocation = invocation()
  return {
    workspaceInvocation,
    workspaceIdentity: {
      sessionKey,
      workspaceId: 'test-workspace',
      authorityRevision: 1,
      canonicalRoot: '/w',
    },
    childWorkspaceRuntime: {
      reserve: async (_parentKey: string, childKey: string) => {
        const childInvocation = invocation()
        return {
          runtime: {
            fs: fsOps,
            invocation: childInvocation,
            identity: {
              sessionKey: childKey,
              workspaceId: 'test-workspace',
              authorityRevision: 1,
              canonicalRoot: '/w',
            },
          },
          commit: () => true,
          close: async () => undefined,
        }
      },
    },
  }
}

function kernel(
  storage: ReturnType<typeof createSqliteStorage>,
  provider: ReturnType<typeof fakeProvider>,
  preset: ReturnType<typeof presetDefaults> = {
    ...presetDefaults(),
    treeBudgetCredits: 100,
    generationLimit: 2,
    maxFanOut: 4,
  },
) {
  Object.assign(provider, { models: () => [model()] })
  return Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset,
    fsOps,
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => Date.now(),
  })
}

const worktrees = {
  create: async () => ({ skipped: 'not-git' as const }),
  finish: async () => ({ action: 'removed' as const }),
}
const spawnDeps = {
  limits: { maxDepth: 2, maxFanOut: 4, isolation: 'shared' as const },
  worktrees,
}

function addSubagentTools(k: ReturnType<typeof Kernel.create>): void {
  k.tools.add(subagentForkTool, { source: 'agnes/subagent', trust: 'builtin' })
  k.tools.add(subagentSpawnTool(spawnDeps), { source: 'agnes/subagent', trust: 'builtin' })
  k.tools.add(subagentCollectTool(spawnDeps), { source: 'agnes/subagent', trust: 'builtin' })
}

describe('real subagent tools on sqlite', () => {
  it('captures createTestHost assemble failure on this Node and drives fork/spawn/collect tools', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-entry-host-'))
    dirs.push(dataDir)
    let hostError = ''
    try {
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        provider: new ScriptedProvider({ models: [fakeModel({ route: 'gw', id: 'm1' })], scripts: [] }),
      })
      await host.close()
    } catch (error) {
      hostError = error instanceof Error ? error.message : String(error)
    }
    if (hostError) expect(hostError).toMatch(/setAuthorizer|E_SEAM_INIT/)
    const log: string[] = [`createTestHost: ${hostError || 'assembled'}`]

    for (let pass = 1; pass <= 2; pass += 1) {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-entry-'))
      dirs.push(dir)
      const dbFile = join(dir, 'sessions.db')

      const limited = fakeProvider([toolTurn('subagent_fork', { question: 'go' }), textTurn('parent')])
      const storage0 = createSqliteStorage({ file: dbFile, tablesDir: join(dir, 'tables-0') })
      const k0 = kernel(storage0, limited, {
        ...presetDefaults(),
        treeBudgetCredits: 100,
        generationLimit: 0,
        maxFanOut: 1,
      })
      addSubagentTools(k0)
      const parent0 = await k0.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r0',
      })
      await parent0.enqueue('next-turn', { content: [{ type: 'text', text: 'fork' }], actor })
      await parent0.run({ until: 'turn-end', signal: new AbortController().signal })
      const forkResult = (await parent0.scan({ type: 'tool/result', limit: 5 }))[0]?.data as
        | { isError?: boolean }
        | undefined
      expect(forkResult?.isError).toBe(true)
      expect(await storage0.listByParent('parent')).toEqual([])
      expect(limited.requests.length).toBe(2)
      log.push(`pass ${pass} over-limit providerCalls=${limited.requests.length} children=0`)
      await k0.close()

      const nobudget = fakeProvider([toolTurn('subagent_fork', { question: 'go' }), textTurn('parent')])
      const storageB = createSqliteStorage({ file: join(dir, 'nb.db'), tablesDir: join(dir, 'tables-b') })
      const kB = kernel(storageB, nobudget, {
        ...presetDefaults(),
        treeBudgetCredits: null,
        generationLimit: 2,
        maxFanOut: 4,
      })
      addSubagentTools(kB)
      const parentB = await kB.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'rb',
      })
      // A preset that never names tree_budget_credits now defaults instead of refusing (see
      // factory.ts's DEFAULT_TREE_BUDGET_CREDITS), so the fork succeeds: the child runs its own
      // turn (consuming the next scripted response as its own text) and the parent's tool/result
      // carries the child's final text, not an error.
      await parentB.enqueue('next-turn', { content: [{ type: 'text', text: 'fork' }], actor })
      await parentB.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(
        ((await parentB.scan({ type: 'tool/result', limit: 5 }))[0]?.data as { isError?: boolean })?.isError,
      ).toBe(false)
      expect(await storageB.listByParent('parent')).toHaveLength(1)
      expect(nobudget.requests.length).toBe(3)
      log.push(`pass ${pass} default-budget providerCalls=${nobudget.requests.length} children=1`)
      await kB.close()

      const liveDb = join(dir, 'live.db')
      const tables = join(dir, 'tables-live')
      const spawnP = fakeProvider([
        toolTurn('subagent_spawn', { task: 'later', isolation: 'shared' }),
        textTurn('parent-ok'),
        textTurn('child-live'),
      ])
      const storage1 = createSqliteStorage({ file: liveDb, tablesDir: tables })
      const k1 = kernel(storage1, spawnP)
      addSubagentTools(k1)
      const parent1 = await k1.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r1',
      })
      await parent1.enqueue('next-turn', { content: [{ type: 'text', text: 'spawn' }], actor })
      await parent1.run({ until: 'turn-end', signal: new AbortController().signal })
      const spawned = (await parent1.scan({ type: 'tool/result', limit: 5 }))[0]?.data as
        | { details?: { childKey?: string }; content?: Array<{ text?: string }> }
        | undefined
      const childKey =
        spawned?.details?.childKey ?? spawned?.content?.[0]?.text?.replace(/^spawned /, '') ?? ''
      expect(childKey.includes('/')).toBe(true)
      log.push(`pass ${pass} spawned ${childKey}`)
      await k1.close()

      const collectP = fakeProvider([
        toolTurn('subagent_collect', { childKey, wait: false }),
        textTurn('collected'),
        toolTurn('subagent_collect', { childKey: 'missing-child', wait: false }),
        textTurn('unknown'),
      ])
      const storage2 = createSqliteStorage({ file: liveDb, tablesDir: tables })
      const k2 = kernel(storage2, collectP)
      addSubagentTools(k2)
      const parent2 = await k2.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r1',
      })
      await parent2.enqueue('next-turn', { content: [{ type: 'text', text: 'collect' }], actor })
      await parent2.run({ until: 'turn-end', signal: new AbortController().signal })
      const results = (await parent2.scan({ type: 'tool/result', limit: 10 })).map(
        (row) => row.data as { isError?: boolean; details?: { childKey?: string } },
      )
      expect(results[0]?.details?.childKey ?? childKey).toBe(childKey)
      expect(results[0]?.isError).not.toBe(true)
      await parent2.enqueue('next-turn', { content: [{ type: 'text', text: 'missing' }], actor })
      await parent2.run({ until: 'turn-end', signal: new AbortController().signal })
      const missing = (await parent2.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.data as
        | { isError?: boolean }
        | undefined
      expect(missing?.isError).toBe(true)
      expect(await storage2.existsSession('missing-child')).toBe(false)
      log.push(`pass ${pass} unknown collect created=${await storage2.existsSession('missing-child')}`)
      await k2.close()
    }
    const entryLog = process.env.AGNES_ENTRY_LOG
    if (entryLog) writeFileSync(entryLog, `${log.join('\n')}\n`)
  }, 40_000)
})

describe('host sqlite + core children factory entry (legacy factory path)', () => {
  it('refuses over-limit create, defaults a missing tree budget, collects a stable spawn key after restart, twice', async () => {
    const log: string[] = []
    for (let pass = 1; pass <= 2; pass += 1) {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-entry-'))
      dirs.push(dir)
      const dbFile = join(dir, 'sessions.db')

      const limited = fakeProvider([textTurn('nope')])
      const k0 = kernel(createSqliteStorage({ file: dbFile, tablesDir: join(dir, 'tables-0') }), limited, {
        ...presetDefaults(),
        treeBudgetCredits: 100,
        generationLimit: 0,
        maxFanOut: 1,
      })
      const parent0 = await k0.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r0',
      })
      const before = limited.requests.length
      await expect(
        parent0.d.children.create({ parent: parent0.key, cwd: '/w', input: 'nope' }),
      ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
      expect(limited.requests.length).toBe(before)
      log.push(`pass ${pass} over-limit providerCalls=${limited.requests.length}`)
      await k0.close()

      // A preset that never names tree_budget_credits gets DEFAULT_TREE_BUDGET_CREDITS instead of
      // a hard E_BUDGET refusal — every shipped preset left this unset, which is a missing knob,
      // not a deliberate "no subagents" decision.
      const nobudget = fakeProvider([textTurn('nope')])
      const kB = kernel(
        createSqliteStorage({ file: join(dir, 'nb.db'), tablesDir: join(dir, 'tables-b') }),
        nobudget,
        {
          ...presetDefaults(),
          treeBudgetCredits: null,
          generationLimit: 2,
          maxFanOut: 4,
        },
      )
      const parentB = await kB.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'rb',
      })
      const beforeB = nobudget.requests.length
      const defaultedChild = await parentB.d.children.create({
        parent: parentB.key,
        cwd: '/w',
        input: 'nope',
      })
      expect(defaultedChild.key).toBeDefined()
      expect(nobudget.requests.length).toBe(beforeB)
      log.push(`pass ${pass} default-budget providerCalls=${nobudget.requests.length}`)
      await kB.close()

      const liveDb = join(dir, 'live.db')
      const tables = join(dir, 'tables-live')
      const spawnP = fakeProvider([toolTurn('delegate', {}), textTurn('child-live'), textTurn('parent-ok')])
      const storage1 = createSqliteStorage({ file: liveDb, tablesDir: tables })
      const k1 = kernel(storage1, spawnP)
      k1.tools.add(
        {
          name: 'delegate',
          description: 'delegate',
          parameters: Type.Object({}),
          meta: {
            isReadOnly: false,
            isDestructive: false,
            isConcurrencySafe: true,
            isOpenWorld: true,
            replay: 'never',
            costHint: undefined,
            deferLoading: undefined,
            requiresApproval: undefined,
          },
          execute: async () => {
            const parent = k1.get('parent')
            if (!parent) throw new Error('missing parent')
            const child = await parent.d.children.createWithKind?.('spawn', {
              parent: parent.key,
              cwd: '/w',
              input: 'later',
              isolation: 'shared',
            })
            return { content: [{ type: 'text', text: child?.key ?? '' }] }
          },
        } as never,
        { source: 'agnes/subagent', trust: 'builtin' },
      )
      const parent1 = await k1.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r1',
      })
      await parent1.enqueue('next-turn', { content: [{ type: 'text', text: 'spawn' }], actor })
      await parent1.run({ until: 'turn-end', signal: new AbortController().signal })
      const childKey = (
        (await parent1.scan({ type: 'tool/result', limit: 5 }))[0]?.data as {
          content?: Array<{ text?: string }>
        }
      )?.content?.[0]?.text
      expect(childKey && childKey.length > 0).toBe(true)
      log.push(`pass ${pass} spawned ${childKey}`)
      await k1.close()

      const storage2 = createSqliteStorage({ file: liveDb, tablesDir: tables })
      const k2 = kernel(storage2, fakeProvider([textTurn('ignored')]))
      const parent2 = await k2.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r1',
      })
      const collected = await parent2.d.children.inspect?.(childKey as string)
      expect(collected).not.toBeNull()
      log.push(`pass ${pass} collect ${childKey} state=${collected?.state}`)
      const missing = await parent2.d.children.inspect?.('missing-child')
      expect(missing).toBeNull()
      expect(await storage2.existsSession('missing-child')).toBe(false)
      log.push(`pass ${pass} unknown collect created=${await storage2.existsSession('missing-child')}`)
      await k2.close()
    }
  }, 30_000)
})
