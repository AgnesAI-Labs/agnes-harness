import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { jcs } from '@agnes/protocol'
import * as systemNode from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { FilePackageOperationStore, withOperationState } from '../src/packages/operations.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function cancel(commandId: string, operationId = 'op-1') {
  const params = { profile: 'local-dev', operationId, clientId: 'client', commandId }
  const { clientId, commandId: command, ...payload } = params
  return {
    identity: { principalId: 'owner', clientId, commandId: command },
    operationId: params.operationId,
    params,
    payloadHash: createHash('sha256')
      .update(jcs({ method: '_agnes/v1/packages.operation.cancel', payload }))
      .digest('hex'),
  }
}
function inspect(operationId: string, at: string) {
  const params = {
    profile: 'local-dev',
    clientId: 'client',
    commandId: operationId,
    source: { type: 'file' as const, ref: 'file:./candidate' },
  }
  const { clientId, commandId, ...payload } = params
  return {
    operation: {
      operationId,
      profile: 'local-dev',
      operation: 'inspect' as const,
      state: 'received' as const,
      cancellable: true,
      retryable: false,
      progress: 0,
      startedAt: at,
      updatedAt: at,
    },
    identity: { principalId: 'owner', clientId, commandId },
    payloadHash: createHash('sha256')
      .update(jcs({ method: '_agnes/v1/packages.inspect', payload }))
      .digest('hex'),
    request: { kind: 'inspect' as const, params },
    now: at,
  }
}
it.each(['before', 'after'] as const)(
  'recovers a %s-rename failure without losing records or acknowledging an unflushed retry',
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-operation-durability-'))
    roots.push(root)
    const directory = join(root, 'operations')
    const store = new FilePackageOperationStore(directory)
    expect(await store.pending()).toEqual([])
    expect(existsSync(directory)).toBe(false)
    // A cancel command is kept only while the operation it names is in the journal.
    await store.admit(inspect('op-1', new Date().toISOString()))
    await store.admitCancel(cancel('first'))
    const replace = systemNode.renameWriteThrough
    const fault = vi.spyOn(systemNode, 'renameWriteThrough').mockImplementation(async (...args) => {
      if (basename(args[1]) !== 'operations.json') return replace(...args)
      if (phase === 'after') await replace(...args)
      throw new Error('injected durability failure')
    })
    await expect(store.admitCancel(cancel('second'))).rejects.toThrow('injected durability failure')
    // Persistent failure must still reject even when a committed retry is already visible on disk.
    await expect(store.admitCancel(cancel('second'))).rejects.toThrow('injected durability failure')
    fault.mockRestore()
    expect((await store.admitCancel(cancel('second'))).state).toBe(phase === 'after' ? 'existing' : 'new')
    await store.admitCancel(cancel('third'))
    const reopened = new FilePackageOperationStore(directory)
    for (const id of ['first', 'second', 'third'])
      expect((await reopened.admitCancel(cancel(id))).state).toBe('existing')
    const saved = JSON.parse(await readFile(join(directory, 'operations.json'), 'utf8'))
    expect(saved.cancels.map((row: { identity: { commandId: string } }) => row.identity.commandId)).toEqual([
      'first',
      'second',
      'third',
    ])
  },
)

it('reclaims a settled operation and its cancel commands seven days after it settles, never pending work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-operation-retention-'))
  roots.push(root)
  const store = new FilePackageOperationStore(join(root, 'operations'))
  const settledAt = '2026-09-13T00:00:00.000Z'
  const at = (offset: number) => new Date(Date.parse(settledAt) + offset).toISOString()
  await store.admit(inspect('op-settled', settledAt))
  await store.update('op-settled', (current) =>
    withOperationState(current, { state: 'completed', now: settledAt }),
  )
  await store.admitCancel({ ...cancel('cancel-settled', 'op-settled'), now: settledAt })
  await store.admit(inspect('op-pending', settledAt))

  // Inside the window a retried command still finds its record.
  const inside = at(7 * 86_400_000 - 1)
  expect((await store.admit(inspect('op-settled', inside))).state).toBe('existing')
  expect((await store.admitCancel({ ...cancel('cancel-settled', 'op-settled'), now: inside })).state).toBe(
    'existing',
  )

  // From seven days after it settled, the next admission reclaims the record and its cancel command.
  const after = at(7 * 86_400_000)
  expect((await store.admit(inspect('op-next', after))).state).toBe('new')
  expect(await store.get('local-dev', 'op-settled')).toBeUndefined()
  expect((await store.pending()).map((record) => record.operation.operationId)).toEqual([
    'op-pending',
    'op-next',
  ])
  const saved = JSON.parse(await readFile(join(root, 'operations', 'operations.json'), 'utf8'))
  expect(saved.cancels).toEqual([])
})

it('refuses historical operation results without rewriting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-operation-upgrade-'))
  roots.push(root)
  const directory = join(root, 'operations')
  const store = new FilePackageOperationStore(directory)
  const now = new Date().toISOString()
  await store.admit(inspect('op-old', now))
  const file = join(directory, 'operations.json')
  const journal = JSON.parse(await readFile(file, 'utf8'))
  const metadata = {
    displayName: 'Legacy',
    summary: 'Synthetic operation result',
    description: 'Historical plugin metadata',
    category: 'example',
    exampleOf: 'acme/parent',
    launches: [
      {
        id: 'work',
        kind: 'business-agent',
        title: 'Work',
        bundle: 'acme/legacy#work',
        preset: 'safe',
        prompt: 'Synthetic draft',
      },
    ],
  }
  const operation = journal.operations[0].operation
  operation.state = 'completed'
  operation.installed = {
    id: 'acme/legacy',
    version: '1.0.0',
    source: { type: 'file', ref: 'file:./legacy' },
    integrity: `sha256-${'a'.repeat(64)}`,
    trusted: true,
    desired: 'enabled',
    actual: 'running',
    contributions: [],
    blockers: [],
    rollbackTarget: null,
    capabilityHash: 'b'.repeat(64),
    metadata,
    kinds: ['bundle'],
    presentation: {
      includes: { kinds: ['bundle'], counts: { bundles: 1 } },
      rows: [{ id: 'ext:acme/legacy', settings: false, metadata }],
    },
  }
  const original = JSON.stringify(journal)
  await writeFile(file, original)
  const reopened = new FilePackageOperationStore(directory)
  await expect(reopened.pending()).rejects.toMatchObject({
    code: 'E_PACKAGE_INTEGRITY',
    detail: { reason: 'clean-home-required' },
    message: expect.stringMatching(/Retired.*clean home/),
  })
  expect(await readFile(file, 'utf8')).toBe(original)
})
