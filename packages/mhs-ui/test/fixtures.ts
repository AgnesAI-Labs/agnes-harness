import type { JsonValue } from '@agnes/protocol'
import type { ClientStream, MhsPorts, Receipt } from '../src/ports.js'
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
export function device(id = 'rover-01') {
  return {
    id,
    revision: 'r1',
    online: true,
    available: true,
    health: 'ok',
    trust: 'trusted',
    description: {
      protocol: 'mhs/v1',
      device: { id, name: id, kind: 'rover', mobile: true },
      ui: { simulated: true, example: 'Mars' },
      state: { speed: { type: 'number', writable: true, min: 0, max: 5 }, temperature: { type: 'number' } },
      sources: [],
      tools: [],
    },
    state: { speed: 1, temperature: 22 },
    position: { map: 'site', x: 1, y: 2, yaw: 0 },
  }
}
export class Stream implements ClientStream {
  frames = new Set<(frame: Uint8Array | JsonValue) => void>()
  drops = new Set<(info: { reason: 'backpressure'; count: number }) => void>()
  disconnects = new Set<(info: { reason: string }) => void>()
  sent: (Uint8Array | JsonValue)[] = []
  closed = false
  send(frame: Uint8Array | JsonValue) {
    if (this.closed) return 'closed' as const
    this.sent.push(frame)
    return 'accepted' as const
  }
  onFrame(fn: (frame: Uint8Array | JsonValue) => void) {
    this.frames.add(fn)
    return () => {
      this.frames.delete(fn)
    }
  }
  onDrop(fn: (info: { reason: 'backpressure'; count: number }) => void) {
    this.drops.add(fn)
    return () => {
      this.drops.delete(fn)
    }
  }
  onDisconnect(fn: (info: { reason: string }) => void) {
    this.disconnects.add(fn)
    return () => {
      this.disconnects.delete(fn)
    }
  }
  close() {
    this.closed = true
    this.frames.clear()
    this.drops.clear()
    this.disconnects.clear()
  }
  emit(frame: JsonValue) {
    for (const listener of this.frames) listener(frame)
  }
}
export function fake() {
  const stream = new Stream(),
    sessionListeners = new Set<() => void>(),
    projectionListeners = new Set<() => void>(),
    effects: { name: string; input: JsonValue; operationId: string }[] = [],
    queries: { name: string; input: JsonValue }[] = [],
    streams: Stream[] = [],
    opened: { name: string; input: JsonValue; operationId: string | undefined }[] = []
  let selected: string | undefined = 'session-a',
    nodes: unknown[] = [],
    currentDevices: unknown[] = [device()],
    effectResult: Receipt | undefined
  const ports: MhsPorts = {
    services: {
      async query(name, input) {
        queries.push({ name, input })
        if (name === 'mhs.devices') return currentDevices
        if (name === 'mhs.maps') return [{ id: 'site', bounds: [0, 0, 10, 10] }]
        if (name === 'mhs.activity') return { events: [], earliest: null }
        if (name === 'mhs.operation') return { state: 'terminal', outcome: { status: 'done' } }
        throw new Error('undeclared')
      },
      async effect(name, input, { operationId }) {
        effects.push({ name, input, operationId })
        if (
          effectResult?.state === 'completed' &&
          effectResult.output &&
          typeof effectResult.output === 'object' &&
          !Array.isArray(effectResult.output) &&
          'operationId' in effectResult.output
        ) {
          return name === 'mhs.lease'
            ? { ...effectResult, operationId, output: { ...effectResult.output, operationId } }
            : { state: 'completed', operationId, output: { state: 'settled' } }
        }
        return effectResult
          ? { ...effectResult, operationId }
          : { state: 'completed', operationId, output: { state: 'settled' } }
      },
      async readOperation(operationId) {
        return { state: 'refused', operationId, code: 'expired' }
      },
    },
    streams: {
      async open(name, input, options) {
        opened.push({ name, input, operationId: options?.controlOperationId })
        const s = streams.length === 0 ? stream : new Stream()
        streams.push(s)
        return s
      },
    },
    session: {
      getSnapshot: () => selected,
      subscribe: (fn) => {
        sessionListeners.add(fn)
        return () => {
          sessionListeners.delete(fn)
        }
      },
      projection: {
        read: async () => ({ status: 'available', value: { nodes } }),
        subscribe: (fn) => {
          projectionListeners.add(fn)
          return () => {
            projectionListeners.delete(fn)
          }
        },
      },
    },
  }
  return {
    ports,
    stream,
    streams,
    opened,
    effects,
    queries,
    set devices(value: unknown[]) {
      currentDevices = value
    },
    set receipt(value: Receipt) {
      effectResult = value
    },
    setSession(value: string | undefined) {
      selected = value
      for (const fn of sessionListeners) fn()
    },
    setNodes(value: unknown[]) {
      nodes = value
      for (const fn of projectionListeners) fn()
    },
    sessionListeners,
    projectionListeners,
  }
}
