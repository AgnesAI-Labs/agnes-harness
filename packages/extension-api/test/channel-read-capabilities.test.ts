import { validateChannelManifest } from '@agnes/protocol'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ChannelAdapter, ChannelCapabilities, MessageEvent, Sender } from '../src/channel-contract.js'

type ReadMethod = 'fetchMessages' | 'listThread' | 'listHistory' | 'listChats' | 'listMembers'

describe('channel read contract', () => {
  it('marks a bot sender without changing what an existing sender means', () => {
    expectTypeOf<Sender['kind']>().toEqualTypeOf<'user' | 'bot' | undefined>()
    expectTypeOf<{ userId: string; raw: Record<string, string> }>().toExtend<Sender>()
  })

  it('declares reads in the adapter capabilities, all optional', () => {
    expectTypeOf<ChannelCapabilities['read']>().toEqualTypeOf<
      | { messages?: boolean; threads?: boolean; history?: boolean; chats?: boolean; members?: boolean }
      | undefined
    >()
    expectTypeOf<{
      edit: boolean
      card: boolean
      thread: boolean
      attachment: boolean
    }>().toExtend<ChannelCapabilities>()
  })

  it('adds five optional cursor-paged reads that return live-event-shaped messages', () => {
    expectTypeOf<ChannelAdapter['fetchMessages']>().toEqualTypeOf<
      ((chatId: string, ids: readonly string[]) => Promise<MessageEvent[]>) | undefined
    >()
    expectTypeOf<ChannelAdapter['listThread']>().toEqualTypeOf<
      | ((
          chatId: string,
          threadId: string,
          opts: { cursor?: string; order: 'asc' | 'desc'; pageSize: number },
        ) => Promise<{ events: MessageEvent[]; cursor?: string }>)
      | undefined
    >()
    expectTypeOf<ChannelAdapter['listHistory']>().toEqualTypeOf<
      | ((
          chatId: string,
          opts: { start: string; end: string; cursor?: string },
        ) => Promise<{ events: MessageEvent[]; cursor?: string }>)
      | undefined
    >()
    expectTypeOf<ChannelAdapter['listChats']>().toEqualTypeOf<
      | ((opts: { cursor?: string }) => Promise<{ chats: { id: string; name?: string }[]; cursor?: string }>)
      | undefined
    >()
    expectTypeOf<ChannelAdapter['listMembers']>().toEqualTypeOf<
      | ((
          chatId: string,
          opts: { cursor?: string },
        ) => Promise<{ members: { userId: string; displayName?: string }[]; cursor?: string }>)
      | undefined
    >()
    // An adapter written before the reads existed is still a complete adapter.
    expectTypeOf<Omit<ChannelAdapter, ReadMethod>>().toExtend<ChannelAdapter>()
  })

  it('keeps reads out of the manifest wire schema: the adapter declares them at run time', () => {
    const manifest = {
      id: 'sample',
      displayName: 'Sample',
      version: '1.0.0',
      connection: { modes: ['websocket'], default: 'websocket' },
      capabilities: { edit: false, card: false, thread: true, attachment: false },
      credentials: { required: [], optional: [], exposes: [] },
      limits: { textChars: 1000, cardBytes: 1000, editWindowMs: 0 },
      events: { supported: ['message'] },
    }
    expect(validateChannelManifest(manifest).ok).toBe(true)
    const declared = { ...manifest, capabilities: { ...manifest.capabilities, read: { history: true } } }
    expect(validateChannelManifest(declared).ok).toBe(false)
  })
})
