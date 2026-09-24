import type { ResolvedProfile } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { supervisorHostFacade } from '../src/supervisor/supervisor.js'

// Account routes are named `account-acct-<uuid>`. A refusal that quoted one tripped HostError's leak
// check and came back as a code-less error, which mapCore cannot turn into PRESET_SWITCH_REJECTED, so
// `agh -p --model <account route>/<typo>` answered INTERNAL_ERROR.
describe('supervisorHostFacade.validateModelSwitch', () => {
  const route = 'account-acct-177e2121-8e3c-4f09-a869-6cfa6ab07602'
  const profile = {
    provider: { routes: [{ route, models: [{ id: 'deepseek-v4-pro' }] }] },
    presets: { allowed: ['standard'] },
    computerUse: { enabled: false },
  } as unknown as ResolvedProfile
  const { host } = supervisorHostFacade(profile, {} as never, {} as never)

  it('accepts a declared model on an account route', () => {
    expect(() => host.validateModelSwitch({ slot: 'primary', route, model: 'deepseek-v4-pro' })).not.toThrow()
  })

  it('refuses an undeclared model on an account route by code, without quoting the route', () => {
    let thrown: unknown
    try {
      host.validateModelSwitch({ slot: 'primary', route, model: 'no-such-model' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'E_MODEL_UNSUPPORTED', detail: { route, model: 'no-such-model' } })
    expect((thrown as Error).message).not.toContain(route)
  })
})
