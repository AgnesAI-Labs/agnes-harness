import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { jcs } from '@agnes/protocol'
import * as systemNode from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { FilePackageOperationStore } from '../src/packages/operations.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function cancel(commandId: string) {
  const params = { profile: 'local-dev', operationId: 'op-1', clientId: 'client', commandId }
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
it.each(['before', 'after'] as const)(
  'recovers a %s-rename failure without losing records or acknowledging an unflushed retry',
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-operation-durability-'))
    roots.push(root)
    const store = new FilePackageOperationStore(root)
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
    const reopened = new FilePackageOperationStore(root)
    for (const id of ['first', 'second', 'third'])
      expect((await reopened.admitCancel(cancel(id))).state).toBe('existing')
    const saved = JSON.parse(await readFile(join(root, 'operations.json'), 'utf8'))
    expect(saved.cancels.map((row: { identity: { commandId: string } }) => row.identity.commandId)).toEqual([
      'first',
      'second',
      'third',
    ])
  },
)
