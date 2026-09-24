import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import factory from '../src/index.js'
import { principalsLocal } from '../src/seam.js'

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../agnes.extension.json', import.meta.url)), 'utf8'),
) as { id: string; capabilities: Record<string, unknown> }

describe('principals-local', () => {
  it('resolves any credential to the local owner and allows everything', async () => {
    const seam = await principalsLocal(fakeSeamInit())
    const a = await seam.resolve({ kind: 'jwt', token: 'x' }, 'cli')
    expect(a).toMatchObject({ org: 'local', role: 'owner', deptPath: [] })
    expect(typeof a.id).toBe('string')
    const d = await seam.authorize(a, 'read', { kind: 'table', id: 't' })
    expect(d).toEqual({ decisionId: 'n/a', effect: 'allow', reason: 'local-owner' })
  })

  it('gives every surface and every credential the same owner id', async () => {
    const seam = await principalsLocal(fakeSeamInit())
    const cli = await seam.resolve({ kind: 'jwt', token: 'x' }, 'cli')
    const im = await seam.resolve(null, 'dingtalk')
    expect(im.id).toBe(cli.id)
    // The one thing about the credential that survives the flattening is where it arrived.
    expect(cli.attrs).toEqual({ surface: 'cli' })
    expect(im.attrs).toEqual({ surface: 'dingtalk' })
  })

  it('never hands out an empty id, which the session schema forbids', async () => {
    // An exported-but-empty USER is what a service manager leaves behind, and `??` does not catch
    // it. Both env vars are set to the empty string, so the fallback is the only thing left.
    const saved = { u: process.env.USER, n: process.env.USERNAME, l: process.env.LOGNAME }
    process.env.USER = ''
    process.env.USERNAME = ''
    process.env.LOGNAME = ''
    try {
      const seam = await principalsLocal(fakeSeamInit())
      expect((await seam.resolve(null, 'cli')).id).toBe('local')
    } finally {
      for (const [k, v] of [
        ['USER', saved.u],
        ['USERNAME', saved.n],
        ['LOGNAME', saved.l],
      ] as const)
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
  })

  it('takes the owner id from the environment when there is one', async () => {
    const saved = process.env.USER
    process.env.USER = 'ada'
    try {
      const seam = await principalsLocal(fakeSeamInit())
      expect((await seam.resolve(null, 'cli')).id).toBe('ada')
    } finally {
      if (saved === undefined) delete process.env.USER
      else process.env.USER = saved
    }
  })

  it('claims no extension capability at all, and its entry registers nothing', async () => {
    expect(manifest.id).toBe('agnes/principals-local')
    expect(manifest.capabilities).toEqual({
      hooks: [],
      slots: [],
      events: false,
      resources: [],
      network: [],
    })
    const reached: string[] = []
    const api = new Proxy(
      {},
      {
        get(_t, prop) {
          reached.push(String(prop))
          return () => undefined
        },
      },
    )
    // A factory that took any authority would have to touch the API object to do it.
    expect(await factory(api as never)).toBeUndefined()
    expect(reached).toEqual([])
  })
})
