import type { ChildAgentResult } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import {
  assertChildAgentAllowed,
  resetChildAgentAllowlists,
  setChildAgentAllowlist,
} from '../src/child/allowlist.js'
import { externalChildren, trackExternalChild } from '../src/child/directory.js'
import { type InProcessChildBackend, inProcessChildAgentProvider } from '../src/child/provider.js'

function backend(): InProcessChildBackend & { messages: string[]; forked: number; resident: number } {
  const messages: string[] = []
  return {
    messages,
    forked: 0,
    resident: 0,
    async startResident() {
      this.resident += 1
      return { id: 'c1' }
    },
    async startFork(input) {
      this.forked += 1
      return { id: 'f1', text: `fork:${input.task}` }
    },
    async sendMessage(_id, text) {
      messages.push(text)
      return { messageId: 'm1' }
    },
    async interrupt() {
      return { accepted: true }
    },
    async cancel() {},
    async list() {
      return [{ id: 'c1', providerId: 'in-process', status: 'idle', continuable: true }]
    },
    onTurn() {
      return () => undefined
    },
    completion: () => new Promise<ChildAgentResult>(() => undefined),
  }
}

it('returns a forked in-process result and refuses a follow-up', async () => {
  const local = backend()
  const provider = inProcessChildAgentProvider(() => local)
  const signal = new AbortController().signal
  const handle = await provider.start('task', { signal, sessionKey: 's', cwd: '/tmp', fork: true })
  const events = []
  for await (const event of handle.events()) events.push(event)
  expect(events).toEqual([
    { type: 'status', status: 'running' },
    { type: 'text', text: 'fork:task' },
    { type: 'status', status: 'completed' },
  ])
  await expect(handle.result()).resolves.toEqual({ status: 'completed', text: 'fork:task' })
  await expect(handle.sendMessage('more', signal)).rejects.toThrow('not continuable')
  expect(local.forked).toBe(1)
  expect(local.resident).toBe(0)
})

it('continues a resident child and honors the session allowlist', async () => {
  const local = backend()
  const provider = inProcessChildAgentProvider(() => local)
  const signal = new AbortController().signal
  const handle = await provider.start('task', { signal, sessionKey: 's', cwd: '/tmp' })
  await expect(handle.sendMessage('more', signal)).resolves.toEqual({ messageId: 'm1' })
  await expect(handle.interrupt()).resolves.toEqual({ accepted: true })
  expect(local.messages).toEqual(['more'])
  expect(await provider.list?.('s')).toEqual([
    { id: 'c1', providerId: 'in-process', status: 'idle', continuable: true },
  ])
  setChildAgentAllowlist('s', { models: ['fast'], providers: ['in-process'] })
  try {
    await expect(provider.start('task', { signal, sessionKey: 's', cwd: '/tmp' })).rejects.toThrow(
      'E_MODEL_UNKNOWN',
    )
    setChildAgentAllowlist('s', { providers: [] })
    await expect(
      provider.start('named', { signal, sessionKey: 's', cwd: '/tmp', model: 'fast' }),
    ).rejects.toThrow('E_UNSUPPORTED')
    assertChildAgentAllowed('other', { providerId: 'in-process' })
  } finally {
    resetChildAgentAllowlists()
  }
})

it('tracks an external child until it is released', () => {
  const untrack = trackExternalChild('s', {
    listing: { id: 'ext', providerId: 'acp', status: 'idle', continuable: true },
  })
  expect(externalChildren('s').map((child) => child.listing.id)).toEqual(['ext'])
  untrack()
  expect(externalChildren('s')).toEqual([])
})
