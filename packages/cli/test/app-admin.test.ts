import { describe, expect, it } from 'vitest'
import { appAdminCommand } from '../src/commands/app-admin.js'
import { type Replies, run } from './admin-harness.js'

const preview = {
  packageId: 'pkg',
  version: '1.0.0',
  integrity: 'sha512-x',
  source: { type: 'file', ref: 'file:./pkg' },
  signature: 'none',
  declarationDigest: 'dd',
  dependencyDiff: {},
  assets: {},
  declaration: { id: 'app' },
  consentDigest: 'dig',
  scope: 'profile',
  dependencies: [],
  replacedRoles: [],
  recovery: 'agh app clear',
  warning: 'w\u001b[2J',
}
const state = {
  revision: 4,
  status: 'host',
  selection: null,
  effective: null,
  assets: {},
  candidates: [{ packageId: 'pkg', applicationId: 'app', version: '1.0.0', available: true }],
}

describe('app show, preview, adopt', () => {
  const replies: Replies = {
    'applications.get': () => state,
    'applications.preview': () => preview,
    'applications.adopt': () => ({ ...state, revision: 5, status: 'active' }),
  }
  it('show and preview read; text is one inert line each', async () => {
    const show = await run(appAdminCommand, ['app', 'show'], replies)
    expect(show.out).toContain('host\trevision 4')
    expect(show.out).toContain('candidate pkg#app\t1.0.0\tavailable')
    const pv = await run(appAdminCommand, ['app', 'preview', 'pkg#app'], replies)
    expect(pv.calls).toEqual([['applications.preview', { profile: 'local-dev', packageId: 'pkg' }]])
    expect(pv.out).toContain('warning w[2J')
    expect((await run(appAdminCommand, ['app', 'show', '--json'], replies)).out).toBe(
      `${JSON.stringify(state)}\n`,
    )
  })
  it('adopt without --yes sends no adopt request; with --yes it adopts the previewed consent at the read revision', async () => {
    const dry = await run(appAdminCommand, ['app', 'adopt', 'pkg#app'], replies)
    expect(dry.calls.map(([m]) => m)).toEqual(['applications.preview'])
    expect(dry.out).toContain('Would adopt pkg#app. Nothing was sent')
    const done = await run(appAdminCommand, ['app', 'adopt', 'pkg#app', '--yes'], replies)
    expect(done.calls.at(-1)?.[1]).toMatchObject({
      profile: 'local-dev',
      packageId: 'pkg',
      expectedRevision: 4,
      consentDigest: 'dig',
    })
    expect(done.out).toContain('adopted pkg#app')
  })
  it('a wrong application id or missing argument is a UsageError and adopts nothing', async () => {
    const wrong = await run(appAdminCommand, ['app', 'adopt', 'pkg#other', '--yes'], replies)
    expect(wrong.exit).toMatchObject({ name: 'UsageError' })
    expect(wrong.calls.map(([m]) => m)).not.toContain('applications.adopt')
    expect((await run(appAdminCommand, ['app', 'preview'], replies)).exit).toMatchObject({
      name: 'UsageError',
    })
  })
})
