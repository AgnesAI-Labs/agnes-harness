import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('/plan', () => {
  it('writes the workspace plan file without calling the session', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agnes-plan-cli-'))
    dirs.push(cwd)
    const app = { cwd, session: {} } as TuiApp
    await expect(runSlash(app, '/plan keep the diff small')).resolves.toEqual({
      active: true,
      text: 'Plan mode is on: keep the diff small',
    })
    expect(JSON.parse(readFileSync(join(cwd, '.agnes', 'plan-mode.json'), 'utf8'))).toMatchObject({
      active: true,
      instruction: 'keep the diff small',
    })
    await expect(runSlash(app, '/plan off')).resolves.toMatchObject({ active: false, text: 'Plan mode is off' })
    expect(JSON.parse(readFileSync(join(cwd, '.agnes', 'plan-mode.json'), 'utf8'))).toEqual({
      active: false,
      updatedAt: expect.any(String),
    })
  })
})
