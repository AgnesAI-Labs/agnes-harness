import type { ResolvedProfile } from '@agnes/host'
import { publicErrorHelp, publicRejectionRpc } from '@agnes/protocol'
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
  const facade = supervisorHostFacade(profile, {} as never, {} as never)
  const { host } = facade

  it('accepts a declared model on an account route', () => {
    expect(() => host.validateModelSwitch({ slot: 'primary', route, model: 'deepseek-v4-pro' })).not.toThrow()
  })

  it('leaves session preset admission to its worker, while keeping deployment-only checks scoped', () => {
    expect(() => host.validatePresetSwitch('review')).toThrow('presets.allowed')
    expect(host.validatePresetSwitch('review', 'bundle-session').view).toBe('review')
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

  it('names a saved configuration that waits for a daemon restart instead of a preset refusal', () => {
    const refusal = (model: string) => {
      try {
        host.validateModelSwitch({ slot: 'primary', route: 'account-acct-new', model })
      } catch (error) {
        return error
      }
      throw new Error('expected a refusal')
    }
    const plain = publicErrorHelp(publicRejectionRpc(refusal('m')))
    expect(plain?.code).toBe('E_MODEL_UNSUPPORTED')
    expect(plain?.reason).not.toContain('preset')
    expect(plain?.reason).not.toContain('restart')
    let pending = true
    facade.observeRestartPending(() => pending)
    const wire = publicRejectionRpc(refusal('m'))
    expect(wire?.data).toEqual({ code: 'E_MODEL_UNSUPPORTED', reason: 'restart-required' })
    const help = publicErrorHelp(wire)
    expect(help?.reason).toContain('daemon restarts')
    expect(help?.action).toContain('agh daemon stop')
    expect(JSON.stringify(wire)).not.toContain('account-acct-new')
    expect(publicErrorHelp(wire, 'zh-CN')?.action).toContain('agh daemon stop')
    pending = false
    expect(publicRejectionRpc(refusal('m'))?.data).toEqual({ code: 'E_MODEL_UNSUPPORTED' })
  })
})
