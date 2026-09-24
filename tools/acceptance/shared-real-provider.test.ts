import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createCredentialStore } from '../../packages/host/src/index.js'

const entry = process.env.AGNES_LOCAL_CLI
const sourceHome = process.env.AGNES_ACCEPTANCE_PROVIDER_HOME
const profile = process.env.AGNES_ACCEPTANCE_PROVIDER_PROFILE ?? 'local-dev'

it.skipIf(!entry || !sourceHome)(
  'configured real Provider completes a built shared-daemon task and a resumed task after restart',
  async () => {
    if (!entry || !sourceHome) throw new Error('real Provider acceptance inputs missing')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(profile)) throw new Error('invalid acceptance profile')
    const root = await mkdtemp(join(tmpdir(), 'agnes-real-'))
    const home = join(root, 'home')
    const cwd = join(root, 'workspace')
    const env = { ...process.env, AGH_HOME: home, AGNES_PROFILE: profile }
    const command = (args: string[]) =>
      new Promise<string>((done, reject) => {
        const child = execFile(
          process.execPath,
          [resolve(entry), ...args],
          { cwd, env, timeout: 120_000, maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            // Do not reflect credential-bearing environment, provider errors or response bodies.
            if (error) reject(new Error('real Provider acceptance command failed'))
            else done(stdout)
          },
        )
        child.stdin?.end()
      })
    try {
      await mkdir(cwd)
      const configuration = await readFile(
        join(sourceHome, 'profiles', profile, 'configuration.json'),
        'utf8',
      )
      const state = JSON.parse(configuration) as {
        profile?: unknown
        provider?: { credentialRef?: unknown }
      }
      if (state.profile !== profile || typeof state.provider?.credentialRef !== 'string')
        throw new Error('configured Provider snapshot is unavailable')
      // Reuse the real private-file validation/writer; never copy the entire user's home or history.
      const credential = await createCredentialStore({ root: sourceHome }).read(state.provider.credentialRef)
      if (credential?.kind !== 'api-key') throw new Error('configured API credential is unavailable')
      await createCredentialStore({ root: home }).putApiKey(state.provider.credentialRef, credential.value)
      const destination = join(home, 'profiles', profile)
      await mkdir(destination, { recursive: true, mode: 0o700 })
      await writeFile(join(destination, 'configuration.json'), configuration, { mode: 0o600 })

      const first = await command(['-p', 'Reply with only AGNES_SHARED_READY. Do not use tools.'])
      expect(first.includes('AGNES_SHARED_READY')).toBe(true)
      const list = JSON.parse(await command(['sessions', '--json'])) as {
        items: Array<{ sessionId: string }>
      }
      const id = list.items[0]?.sessionId
      if (!id) throw new Error('real Provider session was not persisted')
      await command(['daemon', 'stop'])
      const second = await command([
        '-p',
        '--resume',
        id,
        'Reply with only AGNES_RESUME_READY. Do not use tools.',
      ])
      expect(second.includes('AGNES_RESUME_READY')).toBe(true)
    } finally {
      await command(['daemon', 'stop']).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  },
  300_000,
)
