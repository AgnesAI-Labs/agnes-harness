// The operation journal's capacity bound. These cases build 10,000-record journals (heavy tier).
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { FilePackageOperationStore } from '../src/packages/operations.js'

const now = '2026-09-13T00:00:00.000Z'
const weekBefore = new Date(Date.parse(now) - 7 * 86_400_000).toISOString()
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const source = { type: 'file', ref: 'file:./candidate' }
const hash = (method: string, payload: unknown) =>
  createHash('sha256').update(jcs({ method, payload })).digest('hex')
const inspectHash = hash('_agnes/v1/packages.inspect', { profile: 'local-dev', source })

function operation(index: number, state: 'received' | 'completed', at: string) {
  const commandId = `op-${index}`
  return {
    operation: {
      operationId: commandId,
      profile: 'local-dev',
      operation: 'inspect' as const,
      state,
      cancellable: state === 'received',
      retryable: false,
      progress: 0,
      startedAt: at,
      updatedAt: at,
    },
    identity: { principalId: 'owner', clientId: 'client', commandId },
    payloadHash: inspectHash,
    request: {
      kind: 'inspect' as const,
      params: { profile: 'local-dev', clientId: 'client', commandId, source },
    },
  }
}

function cancel(commandId: string, operationId: string) {
  return {
    identity: { principalId: 'owner', clientId: 'client', commandId },
    operationId,
    params: { profile: 'local-dev', operationId, clientId: 'client', commandId },
    payloadHash: hash('_agnes/v1/packages.operation.cancel', { profile: 'local-dev', operationId }),
  }
}

function journal(operations: unknown[], cancels: unknown[]): FilePackageOperationStore {
  const root = mkdtempSync(join(tmpdir(), 'agnes-operation-capacity-'))
  roots.push(root)
  const directory = join(root, 'operations')
  mkdirSync(directory)
  writeFileSync(join(directory, 'operations.json'), JSON.stringify({ version: 1, operations, cancels }))
  return new FilePackageOperationStore(directory)
}

const rows = <T>(count: number, row: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, i) => row(i))

it('admits new commands over 10,000 settled operations and cancel commands naming no operation', async () => {
  const store = journal(
    rows(10_000, (i) => operation(i, 'completed', weekBefore)),
    rows(10_000, (i) => cancel(`cancel-${i}`, 'pkg-not-an-operation')),
  )
  expect((await store.admit({ ...operation(10_000, 'received', now), now })).state).toBe('new')
  expect((await store.admitCancel({ ...cancel('owner-cancel', 'op-10000'), now })).state).toBe('new')
}, 60_000)

it('refuses a new command with a diagnosable error while 10,000 records are still retained', async () => {
  const full = { data: { reason: 'E_PACKAGE_STATE', detail: { reason: 'operation-journal-full' } } }
  // Pending work is never reclaimed, however old.
  const operations = journal(
    rows(10_000, (i) => operation(i, 'received', weekBefore)),
    [],
  )
  await expect(operations.admit({ ...operation(10_000, 'received', now), now })).rejects.toMatchObject(full)
  const cancels = journal(
    [operation(0, 'received', now)],
    rows(10_000, (i) => cancel(`cancel-${i}`, 'op-0')),
  )
  await expect(cancels.admitCancel({ ...cancel('one-more', 'op-0'), now })).rejects.toMatchObject(full)
}, 60_000)
