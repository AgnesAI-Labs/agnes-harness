import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { contextAdmin } from './context-admin.js'

it('requires same-origin administration and registered workspaces before reading rules or writing settings', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agh-context-admin-'))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'AGENTS.md'), 'Project rules')
  const handle = contextAdmin('http://127.0.0.1:4177', async () => [{ path: cwd, available: true }], home)
  const request = async (body: unknown, origin = 'http://127.0.0.1:4177') => {
    const bytes = Buffer.from(JSON.stringify(body))
    const input = Readable.from([...bytes].map((byte) => Buffer.from([byte]))) as IncomingMessage
    Object.assign(input, {
      url: '/api/context',
      method: 'POST',
      headers: { host: '127.0.0.1:4177', origin, 'content-type': 'application/json' },
    })
    let status = 0
    let text = ''
    const output = {
      writeHead: (code: number) => {
        status = code
      },
      end: (value: string) => {
        text = value
      },
    } as unknown as ServerResponse
    await handle(input, output)
    return { status, body: JSON.parse(text) }
  }
  try {
    expect((await request({ cwd })).body.rules.files[0]?.content).toBe('Project rules')
    expect((await request({ cwd: home, config: { timeZone: 'UTC' } })).status).toBe(400)
    expect((await request({ config: { timeZone: 'UTC' } }, 'https://external.invalid')).status).toBe(403)
    expect((await request({ config: { timeZone: 'Asia/Shanghai' } })).status).toBe(200)
    expect((await request({ config: { customSkillRoots: [join(home, '技能')] } })).status).toBe(200)
    expect(JSON.parse(readFileSync(join(home, 'context.json'), 'utf8')).customSkillRoots).toEqual([
      join(home, '技能'),
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
