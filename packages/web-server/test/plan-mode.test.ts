import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPlanCommand } from '../src/plan-mode.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('applyPlanCommand', () => {
  it('writes only the plan file under an existing absolute workspace', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agnes-plan-web-'))
    dirs.push(cwd)
    expect(applyPlanCommand(cwd, '/plan look first')).toMatchObject({
      ok: true,
      active: true,
      text: 'Plan mode is on: look first',
    })
    expect(JSON.parse(readFileSync(join(cwd, '.agnes', 'plan-mode.json'), 'utf8'))).toMatchObject({
      active: true,
      instruction: 'look first',
    })
    expect(applyPlanCommand(cwd, '/plan off')).toMatchObject({ ok: true, active: false })
  })

  it('refuses a relative path, a missing directory, and a line that is not /plan', () => {
    expect(applyPlanCommand('relative', '/plan')).toEqual({ ok: false, code: 'INVALID_REQUEST' })
    expect(applyPlanCommand('/tmp/agnes-plan-mode-missing-dir', '/plan')).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    })
    const cwd = mkdtempSync(join(tmpdir(), 'agnes-plan-web-'))
    dirs.push(cwd)
    expect(applyPlanCommand(cwd, 'hello')).toEqual({ ok: false, code: 'INVALID_REQUEST' })
  })
})
