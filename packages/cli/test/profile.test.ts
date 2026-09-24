import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeClient } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { profileInspect, profileList, profileTrust } from '../src/commands/profile.js'

describe('profileList', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('lists builtin templates and user-defined profiles, skipping directories with no profile.yaml', () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-list-'))
    homes.push(home)
    mkdirSync(join(home, 'profiles', 'mine'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'mine', 'profile.yaml'), 'name: mine\n')
    mkdirSync(join(home, 'profiles', 'stray'), { recursive: true })

    const out = profileList(home)

    expect(out).toContain('local-dev\t(builtin template)')
    expect(out).toContain('enterprise\t(builtin template)')
    expect(out).toContain(`mine\t${join(home, 'profiles', 'mine')}`)
    expect(out).not.toContain('stray')
  })

  it('lists only builtin templates when the profiles directory does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-list-empty-'))
    homes.push(home)

    const out = profileList(home)

    expect(out).toContain('local-dev\t(builtin template)')
    expect(out).not.toContain('\n\n')
  })
})

describe('profileInspect', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  function deps(home: string) {
    return { env: {}, home, cwd: home, agnesVersion: '0.0.0-test', log: () => {} }
  }

  it('prints a short summary without --resolved', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-inspect-'))
    homes.push(home)
    const out = await profileInspect(
      { command: 'profile', positional: ['inspect', 'local-dev'], resolved: false } as never,
      deps(home),
      'local-dev',
    )
    expect(out).toContain('local-dev')
    expect(out).toContain('dataDir')
    expect(() => JSON.parse(out)).toThrow()
  })

  it('prints the full resolved profile as JSON with --resolved', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-inspect-resolved-'))
    homes.push(home)
    const out = await profileInspect(
      { command: 'profile', positional: ['inspect', 'local-dev'], resolved: true } as never,
      deps(home),
      'local-dev',
    )
    const parsed = JSON.parse(out)
    expect(parsed.name).toBe('local-dev')
    expect(typeof parsed.hash).toBe('string')
    expect(typeof parsed.dataDir).toBe('string')
  })

  it('rejects when the profile does not exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-inspect-nonexistent-'))
    homes.push(home)
    await expect(
      profileInspect(
        { command: 'profile', positional: ['inspect', 'nonexistent-xyz'], resolved: false } as never,
        deps(home),
        'nonexistent-xyz',
      ),
    ).rejects.toThrow()
  })
})

describe('profileTrust', () => {
  it('calls client.packages.trustWorkspace with a minted clientId/commandId and formats the result', async () => {
    const calls: unknown[] = []
    const client = {
      async clientId() {
        return 'cli-client'
      },
      packages: {
        trustWorkspace: async (params: unknown) => {
          calls.push(params)
          return { hash: `sha256-${'a'.repeat(64)}` }
        },
      },
    } as unknown as NodeClient
    const out = await profileTrust(client, 'enterprise', '/deploy/xinwei')
    expect(out).toBe(`trusted /deploy/xinwei (hash sha256-${'a'.repeat(64)}) for profile enterprise`)
    expect(calls).toEqual([
      {
        profile: 'enterprise',
        clientId: 'cli-client',
        commandId: expect.any(String),
        deployDir: '/deploy/xinwei',
      },
    ])
  })
})
