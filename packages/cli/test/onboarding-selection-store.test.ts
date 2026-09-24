import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialStore } from '@agnes/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOnboardingSelection, saveOnboardingSelection } from '../src/onboarding/selection-store.js'
import type { OnboardingResult } from '../src/onboarding/state.js'

const homes: string[] = []

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'agnes-onboarding-selection-'))
  homes.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const result: OnboardingResult = {
  profile: 'local-dev',
  route: 'openai',
  model: 'gpt-5',
  thinking: 'high',
  credentialRef: 'secret://openai/default',
}
const apiKey = 'sk-this-is-only-a-test-key'

function credentials(read: CredentialStore['read']): Pick<CredentialStore, 'read'> {
  return { read }
}

describe('persisted onboarding selection', () => {
  it('saves only metadata on first setup and reads it back for the next startup', async () => {
    const root = await home()
    await saveOnboardingSelection(root, result)

    const raw = await readFile(join(root, 'profiles', 'local-dev', 'onboarding-selection.json'), 'utf8')
    expect(raw).toContain('"route":"openai"')
    expect(raw).toContain('"model":"gpt-5"')
    expect(raw).not.toContain(apiKey)
    expect(raw).not.toMatch(/accessToken|refreshToken|value/i)

    const read = vi.fn(async () => ({
      version: 1 as const,
      kind: 'api-key' as const,
      provider: 'openai',
      value: apiKey,
    }))
    await expect(loadOnboardingSelection(root, 'local-dev', credentials(read))).resolves.toEqual(result)
    expect(read).toHaveBeenCalledExactlyOnceWith('secret://openai/default')
  })

  it('fails safe for corrupt data, an unrelated profile, or a route/ref mismatch', async () => {
    const root = await home()
    const file = join(root, 'profiles', 'local-dev', 'onboarding-selection.json')
    await saveOnboardingSelection(root, result)
    const read = vi.fn(async () => ({
      version: 1 as const,
      kind: 'api-key' as const,
      provider: 'openai',
      value: apiKey,
    }))

    await writeFile(file, '{not-json\n')
    await expect(loadOnboardingSelection(root, 'local-dev', credentials(read))).resolves.toBeUndefined()
    expect(read).not.toHaveBeenCalled()

    await writeFile(file, `${JSON.stringify({ ...result, profile: 'other-profile', version: 1 })}\n`)
    await expect(loadOnboardingSelection(root, 'local-dev', credentials(read))).resolves.toBeUndefined()

    await writeFile(
      file,
      `${JSON.stringify({ ...result, credentialRef: 'secret://deepseek/default', version: 1 })}\n`,
    )
    await expect(loadOnboardingSelection(root, 'local-dev', credentials(read))).resolves.toBeUndefined()
  })

  it('fails safe when the matching API-key credential was removed or no longer matches the provider', async () => {
    const root = await home()
    await saveOnboardingSelection(root, result)
    await expect(
      loadOnboardingSelection(
        root,
        'local-dev',
        credentials(async () => null),
      ),
    ).resolves.toBeUndefined()
    await expect(
      loadOnboardingSelection(
        root,
        'local-dev',
        credentials(async () => ({ version: 1, kind: 'api-key', provider: 'deepseek', value: apiKey })),
      ),
    ).resolves.toBeUndefined()
  })
})
