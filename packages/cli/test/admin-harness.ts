import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@agnes/sdk'
import { afterEach } from 'vitest'
import { parseArgs } from '../src/args.js'
import { FakeEndpoint } from './fake-endpoint.js'

export const clients: Array<Awaited<ReturnType<typeof createClient>>> = []
const dirs: string[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

export function file(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'agh-plugin-admin-'))
  dirs.push(dir)
  const path = join(dir, 'in.json')
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

export type Replies = Record<string, (params: Record<string, unknown>) => unknown>

export async function run(
  command: (p: ReturnType<typeof parseArgs>, client: never, write: (t: string) => void) => Promise<unknown>,
  argv: string[],
  replies: Replies,
) {
  const endpoint = new FakeEndpoint()
  endpoint.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
  for (const [method, reply] of Object.entries(replies))
    endpoint.on(`_agnes/v1/${method}`, (params) => reply(params as Record<string, unknown>))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  const exit = await command(parseArgs(argv), client as never, (t) => {
    out += t
  }).catch((e: Error) => e)
  return {
    exit,
    out,
    calls: endpoint.calls
      .filter((c) => c.method.startsWith('_agnes/v1/'))
      .map((c) => [c.method.slice(10), c.params]),
  }
}
