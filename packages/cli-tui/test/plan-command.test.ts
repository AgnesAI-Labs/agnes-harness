import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'
import { tt } from '../src/locale-extended.js'

it('routes plan commands through the authenticated session backend and displays unavailable mode as off', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agnes-plan-cli-'))
  const call = vi.fn(async () => ({ active: true, text: 'Plan mode is on: keep the diff small' }))
  const app = { cwd, session: { id: 'session-plan', client: { call } } } as unknown as TuiApp
  try {
    await expect(runSlash(app, '/plan keep the diff small')).resolves.toMatchObject({ active: true })
    expect(call).toHaveBeenCalledWith('_agnes/v1/admin.plan', {
      cwd,
      sessionId: 'session-plan',
      line: '/plan keep the diff small',
    })
    expect(existsSync(join(cwd, '.agh/plan-mode.json'))).toBe(false)
    call.mockResolvedValueOnce({ active: false, text: 'Plan mode is off (provider unavailable)' })
    await expect(runSlash(app, '/plan')).resolves.toMatchObject({
      text: 'Plan mode is off (provider unavailable)',
    })
    call.mockRejectedValueOnce(new Error('backend refused'))
    await expect(runSlash(app, '/plan off')).rejects.toThrow('backend refused')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

it.each(['en', 'zh-CN'] as const)(
  'explains routine approval bypass without claiming full access in %s',
  async (locale) => {
    expect(tt('commands.yolo', locale)).toContain(locale === 'en' ? 'routine approvals' : '普通审批')
    expect(tt('commands.preset', locale)).toContain('security')
    const setYolo = vi.fn(async () => ({ effectiveFromSeq: 12 }))
    const app = { session: { id: 's', setYolo, client: {} } } as unknown as TuiApp
    const result = await runSlash(app, '/yolo')
    expect(result.text).toContain('routine approvals skipped')
    expect(result.text).not.toContain('full access')
  },
)
