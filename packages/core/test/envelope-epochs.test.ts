import type { RequestBody } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { type EnvelopeEpochs, nonceFor, recordHeader } from '../src/request/envelope-epochs.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const envelopeId = (messages: RequestBody['messages'], marker: string): string | undefined => {
  const message = messages.find((item) => JSON.stringify(item).includes(marker))
  return /<untrusted id=\\?"([^"\\]+)/u.exec(JSON.stringify(message))?.[1]
}

describe('ledger envelope epochs', () => {
  it('keeps the last header in a same-nonce run', () => {
    const epochs: EnvelopeEpochs = []
    recordHeader(epochs, 10, 'A')
    recordHeader(epochs, 30, 'A')
    recordHeader(epochs, 50, 'B')
    expect(epochs).toEqual([
      { lastHeaderSeq: 30, nonce: 'A' },
      { lastHeaderSeq: 50, nonce: 'B' },
    ])
    expect(nonceFor(epochs, 9)).toBe('A')
    expect(nonceFor(epochs, 25)).toBe('A')
    expect(nonceFor(epochs, 35)).toBe('B')
    expect(nonceFor(epochs, 55)).toBeUndefined()
  })

  it('never assigns a prior-turn nonce across failed sends, resume headers, or a fork cut', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const epochs: EnvelopeEpochs = []
      const headers: Array<{ seq: number; nonce: string }> = []
      const nodes: Array<{ seq: number; turn: number }> = []
      let state = seed
      let failedSends = 0
      let resumedHeaders = 0
      for (let turn = 0; turn < 30; turn++) {
        nodes.push({ seq: turn * 10 + 1, turn })
        state = (state * 1664525 + 1013904223) >>> 0
        const count = state % 3
        if (count === 0) failedSends++
        if (count === 2) resumedHeaders++
        for (let index = 0; index < count; index++) {
          const header = { seq: turn * 10 + 2 + index, nonce: `turn-${turn}` }
          headers.push(header)
          recordHeader(epochs, header.seq, header.nonce)
        }
        nodes.push({ seq: turn * 10 + 5, turn })
      }
      expect(failedSends).toBeGreaterThan(0)
      expect(resumedHeaders).toBeGreaterThan(0)
      for (const node of nodes) {
        const firstSent = headers.find((header) => header.seq > node.seq)?.nonce
        const selected = nonceFor(epochs, node.seq) ?? 'turn-30'
        expect(selected).toBe(firstSent ?? 'turn-30')
        expect(Number(selected.slice(5))).toBeGreaterThanOrEqual(node.turn)
      }
      // A failed derivation without a durable header cannot pin the final node to its unsent nonce.
      expect(nonceFor(epochs, 300)).toBeUndefined()
      expect(nonceFor(epochs, 300) ?? 'turn-31').toBe('turn-31')

      const forkAt = 155
      const visibleHeaders = headers.filter((header) => header.seq <= forkAt)
      const inherited: EnvelopeEpochs = []
      for (const header of visibleHeaders) recordHeader(inherited, header.seq, header.nonce)
      for (const node of nodes.filter((item) => item.seq <= forkAt)) {
        const visibleFirst = visibleHeaders.find((header) => header.seq > node.seq)?.nonce
        const selected = nonceFor(inherited, node.seq) ?? 'turn-30'
        expect(selected).toBe(visibleFirst ?? 'turn-30')
        expect(Number(selected.slice(5))).toBeGreaterThanOrEqual(node.turn)
      }
    }
  })

  it('keeps a forked ancestor nonce but never assigns the parent post-trigger nonce to the trigger', async () => {
    const provider = fakeProvider([
      textTurn('first parent answer'),
      textTurn('second parent answer'),
      textTurn('child answer'),
    ])
    const kernel = Kernel.create({
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider,
      contract: { contract_id: null, parser_version: '1' },
      preset: presetDefaults(),
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      timers: noTimers,
      clock: () => 1_757_203_200_000,
    })
    try {
      const parent = await kernel.session('parent', {
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'parent-run',
      })
      for (const text of ['ancestor untrusted marker', 'trigger untrusted marker']) {
        await parent.enqueue('next-turn', {
          content: [{ type: 'text', text }],
          actor,
          trust: 'untrusted',
        })
        expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'completed',
        )
      }
      const trigger = (await parent.scan({ fromSeq: 1, toSeq: parent.lastSeq })).find(
        (row) => row.type === 'user/message' && JSON.stringify(row.data).includes('trigger untrusted marker'),
      )
      if (!trigger) throw new Error('missing fork trigger')
      const handle = await parent.d.children.create({
        parent: parent.key,
        cwd: '/w',
        input: 'child task',
        forkAt: trigger.seq,
      })
      try {
        await handle.run('child task')
        const first = provider.requests[0]
        const second = provider.requests[1]
        const child = provider.requests.find((request) => request.sessionKey === handle.key)
        if (!first || !second || !child) throw new Error('missing parent or child request')
        const ancestor = envelopeId(second.messages, 'ancestor untrusted marker')
        const triggerInParent = envelopeId(second.messages, 'trigger untrusted marker')
        const triggerInChild = envelopeId(child.messages, 'trigger untrusted marker')
        expect(ancestor).toBeTruthy()
        expect(envelopeId(first.messages, 'ancestor untrusted marker')).toBe(ancestor)
        expect(envelopeId(child.messages, 'ancestor untrusted marker')).toBe(ancestor)
        expect(triggerInParent).toBeTruthy()
        expect(triggerInChild).toBeTruthy()
        expect(triggerInChild).not.toBe(triggerInParent)
        expect(triggerInChild).not.toBe(ancestor)
      } finally {
        await handle.close()
      }
    } finally {
      await kernel.close()
    }
  })
})
