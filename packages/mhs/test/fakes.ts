import { expect } from 'vitest'
import { WebSocket } from 'ws'

// biome-ignore lint/suspicious/noExplicitAny: the fake device reads protocol messages loosely
export type Msg = Record<string, any>

/** A device speaking the command channel by hand, so each test controls every message. */
export class FakeDevice {
  readonly inbox: Msg[] = []
  private waiters: ((m: Msg) => void)[] = []
  closed: Promise<number>

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as Msg
      // Clock synchronization runs by itself after registration; answer it like a device would.
      if (m.method === 'mhs/time') return this.reply(m.id, { t: Date.now() / 1000 + 100 })
      const w = this.waiters.shift()
      if (w) w(m)
      else this.inbox.push(m)
    })
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  }

  static async open(url: string): Promise<FakeDevice> {
    const ws = new WebSocket(url, 'mhs.v1')
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return new FakeDevice(ws)
  }

  next(): Promise<Msg> {
    const m = this.inbox.shift()
    if (m) return Promise.resolve(m)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  send(m: Msg): void {
    this.ws.send(JSON.stringify(m))
  }

  reply(id: string, result: Msg): void {
    this.send({ jsonrpc: '2.0', id, result })
  }

  notify(method: string, params: Msg): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  async register(description: Msg): Promise<Msg> {
    this.send({ jsonrpc: '2.0', id: '1', method: 'mhs/register', params: description })
    return this.next()
  }
}

/** The device's Nerve channel. */
export class FakeNerve {
  readonly inbox: (Msg | Buffer)[] = []
  closed: Promise<number>

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) =>
      this.inbox.push(isBinary ? (data as Buffer) : JSON.parse(data.toString())),
    )
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  }

  static async open(
    base: string,
    hello: Msg | null = { type: 'hello', device: 'cam-01' },
  ): Promise<FakeNerve> {
    const ws = new WebSocket(base.replace('/ws/mhs', '/ws/nerve'), 'mhs.v1')
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const nerve = new FakeNerve(ws)
    if (hello) nerve.send(hello)
    return nerve
  }

  send(m: Msg | Buffer): void {
    this.ws.send(Buffer.isBuffer(m) ? m : JSON.stringify(m))
  }
}

export const until = async (check: () => boolean, ms = 1000) => {
  for (let i = 0; i < ms / 10 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}
