/**
 * The Feishu Source's way to Feishu: the bundled-app channels of the AGH Feishu channel instance the Source names. A
 * channel declares each read it supports; a read it does not declare is refused with `CAPABILITY_DENIED`, which the
 * Source records as a missing feature and degrades around instead of failing.
 */
import type { BundledAppChannels } from '@agnes/extension-api'
import type { Choice } from './kind.js'

/** The optional channel reads, as `capabilities().read` names them. */
export type FeishuFeature = 'messages' | 'threads' | 'history' | 'chats' | 'members'
export const FEISHU_FEATURES: readonly FeishuFeature[] = [
  'messages',
  'threads',
  'history',
  'chats',
  'members',
]

/** The channels and the instance the Source reads and replies through. */
export interface FeishuIo {
  readonly channels: BundledAppChannels
  /** The channel instance id from the Source's settings; empty while unset. */
  readonly channel: string
  /** Features the channel refused, so far in this run. */
  readonly missing: Set<FeishuFeature>
  readonly signal?: AbortSignal | undefined
}

/**
 * The channel plugin and instance the `instance` setting names, written `<plugin id>/<instance id>` (a plugin id may
 * contain `/`, an instance id never does). A bare instance id names no plugin; it is enough to subscribe groups.
 */
export function instanceRef(value: string): { pluginId: string; instanceId: string } {
  const at = value.lastIndexOf('/')
  return at < 0
    ? { pluginId: '', instanceId: value }
    : { pluginId: value.slice(0, at), instanceId: value.slice(at + 1) }
}

/** The `data.code` of a channel error (the error name when it has none), or undefined for other errors. */
export function channelCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const data = (error as { data?: { code?: unknown } }).data
  if (typeof data?.code === 'string') return data.code
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /^[A-Z][A-Z_]+$/.test(message) ? message : undefined
}

/** An error as one line: its message, or the channel's error code with its data. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const code = channelCode(error)
  return code ? `${code} ${JSON.stringify((error as { data?: unknown }).data ?? {})}` : String(error)
}

/** A read the channel does not support; the message says what is missing. */
export class FeishuUnsupported extends Error {
  constructor(readonly feature: FeishuFeature) {
    super(`The Feishu channel does not support reading ${FEATURE_TEXT[feature]}`)
    this.name = 'FeishuUnsupported'
  }
}
const FEATURE_TEXT: Record<FeishuFeature, string> = {
  messages: 'messages by id',
  threads: 'threads',
  history: 'chat history',
  chats: 'the chat list',
  members: 'chat members',
}

/**
 * Runs one read of `feature`. A refusal for an undeclared read marks the feature missing and throws
 * `FeishuUnsupported`; a read that works again clears the mark.
 */
export async function channelRead<T>(
  io: FeishuIo,
  feature: FeishuFeature,
  read: (channels: BundledAppChannels, channel: string) => Promise<T>,
): Promise<T> {
  if (!io.channel) throw new Error('The Feishu Source has no channel instance set')
  io.signal?.throwIfAborted()
  try {
    const result = await read(io.channels, io.channel)
    io.missing.delete(feature)
    io.signal?.throwIfAborted()
    return result
  } catch (error) {
    if (channelCode(error) !== 'CAPABILITY_DENIED') throw error
    io.missing.add(feature)
    throw new FeishuUnsupported(feature)
  }
}

/**
 * Finds which reads the channel declares without reading anything: each read is called with arguments the host refuses
 * before it reaches the channel, so a declared read answers `INVALID_PARAMS` and an undeclared one `CAPABILITY_DENIED`.
 * The chat list has no such argument and is read for real (it is small and the Source reads it anyway).
 * @throws the `CHANNEL_UNAVAILABLE` refusal while the channel row is not running.
 */
export async function probeFeatures(io: FeishuIo): Promise<Set<FeishuFeature>> {
  const probes: Record<FeishuFeature, (channels: BundledAppChannels, channel: string) => Promise<unknown>> = {
    messages: (channels, channel) => channels.fetchMessages(channel, '', []),
    threads: (channels, channel) => channels.listThread(channel, '', '', { order: 'asc', limit: 0 }),
    history: (channels, channel) => channels.listHistory(channel, '', { start: '', end: '' }),
    chats: (channels, channel) => channels.listChats(channel),
    members: (channels, channel) => channels.listMembers(channel, ''),
  }
  for (const feature of FEISHU_FEATURES) {
    try {
      await probes[feature](io.channels, io.channel)
      io.missing.delete(feature)
    } catch (error) {
      const code = channelCode(error)
      if (code === 'CAPABILITY_DENIED') io.missing.add(feature)
      // A running row is needed to tell; any other answer means the read reached the channel's checks or the channel.
      else if (code === 'CHANNEL_UNAVAILABLE') throw error
      else io.missing.delete(feature)
    }
  }
  return new Set(io.missing)
}

/** The io for one call: the same channels and record of missing features, aborted by `signal` too. */
export const withSignal = (io: FeishuIo, signal?: AbortSignal): FeishuIo =>
  signal ? { ...io, signal: io.signal ? AbortSignal.any([io.signal, signal]) : signal } : io

/**
 * What the Feishu Source shares across its parts in one run: the channels, the features found missing, its context once
 * its kind is registered, and the operator's log, which gets each change of the Source's health.
 */
export interface FeishuLink {
  readonly channels: BundledAppChannels
  readonly missing: Set<FeishuFeature>
  context?: import('./host.js').SourceContext
  log?(message: string): void
  /** The last health line logged per entry. */
  readonly logged: Map<string, string>
  /** Whether the instance is claimed or the listed chats are subscribed now; history is recovered only then. */
  listening: boolean
  /** Replies being sent, by `chat\0asked message`, with the root they answer and how many are in flight. */
  readonly sending: Map<string, { root: string; count: number }>
  /** Lists the running channel instances the `instance` setting may name; absent, the setting is typed. */
  instances?: () => Promise<Choice[]>
}
export const feishuLink = (channels: BundledAppChannels, log?: (message: string) => void): FeishuLink => ({
  channels,
  missing: new Set(),
  logged: new Map(),
  listening: false,
  sending: new Map(),
  ...(log ? { log } : {}),
})
/** The io of `link` on the channel instance `channel`. */
export const linkIo = (link: FeishuLink, channel: string, signal?: AbortSignal): FeishuIo => ({
  channels: link.channels,
  channel,
  missing: link.missing,
  ...(signal ? { signal } : {}),
})
