import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { rpcError } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { contextAdmin } from './context-admin.js'

it('requires same-origin administration, validates parameters and delegates workspace authority to daemon', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agh-context-admin-'))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'AGENTS.md'), 'Project rules')
  const forwarded: unknown[] = []
  const handle = contextAdmin('http://127.0.0.1:4177', async (input) => {
    forwarded.push(input)
    if (input.cwd === home) throw { rpc: rpcError('CAPABILITY_DENIED') }
    return {
      config: {
        rulesEnabled: true,
        instructionFiles: [],
        localInstructionFiles: [],
        maxBytes: 0,
        maxSourceBytes: 0,
        timeEnabled: true,
        timeZone: input.config?.timeZone ?? 'UTC',
        refreshIntervalMs: 0,
        customSkillRoots: input.config?.customSkillRoots ?? [],
      },
      workspaces: [{ path: cwd, available: true }],
      ...(input.cwd
        ? {
            rules: {
              root: cwd,
              files: [
                {
                  path: join(cwd, 'AGENTS.md'),
                  scope: cwd,
                  content: 'Project rules',
                  trust: 'repository' as const,
                },
              ],
              skipped: [],
              content: 'Project rules',
            },
          }
        : {}),
    }
  })
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
    expect((await request({ cwd: home, config: { timeZone: 'UTC' } })).status).toBe(403)
    expect((await request({ config: { timeZone: 'UTC' } }, 'https://external.invalid')).status).toBe(403)
    expect((await request({ config: { timeZone: 'Asia/Shanghai' } })).status).toBe(200)
    expect((await request({ config: { customSkillRoots: [join(home, '技能')] } })).status).toBe(200)
    expect(forwarded).toEqual([
      { cwd },
      { cwd: home, config: { timeZone: 'UTC' } },
      { config: { timeZone: 'Asia/Shanghai' } },
      { config: { customSkillRoots: [join(home, '技能')] } },
    ])
    expect((await request({ config: { maxBytes: 60001 } })).status).toBe(400)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
