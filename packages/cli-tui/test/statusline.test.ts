import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import { readPrefs, updatePrefs } from '../src/prefs.js'
import { STATUS_FIELDS, StatusLineConfig } from '../src/statusline-config.js'
import { TuiTheme } from '../src/theme.js'
import { readTheme, saveTheme } from '../src/theme-preference.js'
import { StatusLinePicker } from '../src/views/statusline-picker.js'

const dirs: string[] = []
const file = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-prefs-'))
  dirs.push(dir)
  return join(dir, 'tui-theme.json')
}
/** A path whose parent is a regular file, so nothing can be written there. */
const blocked = (): string => {
  const path = file()
  writeFileSync(path, '{}')
  return join(path, 'child')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

describe('preferences file', () => {
  it('merges a patch into what is there, removes a key set to undefined and refuses to overwrite a damaged file', () => {
    const path = file()
    expect(updatePrefs(path, { theme: 'dark' })).toBe(true)
    expect(updatePrefs(path, { title: 'cwd', statusLine: { hide: ['cwd'] } })).toBe(true)
    expect(json(path)).toEqual({ theme: 'dark', title: 'cwd', statusLine: { hide: ['cwd'] } })
    expect(updatePrefs(path, { title: undefined })).toBe(true)
    expect(json(path)).toEqual({ theme: 'dark', statusLine: { hide: ['cwd'] } })
    writeFileSync(path, '[1,2]')
    expect(readPrefs(path)).toEqual({})
    writeFileSync(path, '{broken')
    expect(updatePrefs(path, { theme: 'light' })).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    writeFileSync(path, ' \n')
    expect(updatePrefs(path, { theme: 'light' })).toBe(true)
    writeFileSync(path, '\uFEFF{"title":"cwd"}')
    expect(updatePrefs(path, { theme: 'dark' })).toBe(true)
    expect(json(path)).toEqual({ title: 'cwd', theme: 'dark' })
    expect(updatePrefs(undefined, { theme: 'light' })).toBe(false)
  })

  it('keeps the theme when the status line is saved, and the status line when the theme is', () => {
    const path = file()
    saveTheme(path, 'light')
    const config = new StatusLineConfig(path)
    expect(config.toggle('cwd')).toBe(true)
    expect(readTheme(path)).toBe('light')
    saveTheme(path, 'mono')
    expect(json(path)).toEqual({ theme: 'mono', statusLine: { hide: ['cwd'] } })
    expect(new StatusLineConfig(path).shows('cwd')).toBe(false)
  })
})

describe('StatusLineConfig', () => {
  it('shows everything by default, remembers a toggle across runs and goes back with reset', () => {
    const path = file()
    const config = new StatusLineConfig(path)
    for (const field of STATUS_FIELDS) expect(config.shows(field)).toBe(true)
    expect(config.toggle('branch')).toBe(true)
    expect(config.toggle('model')).toBe(true)
    const again = new StatusLineConfig(path)
    expect([again.shows('branch'), again.shows('model'), again.shows('usage')]).toEqual([false, false, true])
    expect(config.toggle('model')).toBe(true)
    expect(json(path)).toEqual({ statusLine: { hide: ['branch'] } })
    expect(config.reset()).toBe(true)
    expect(json(path)).toEqual({})
    expect(new StatusLineConfig(path).shows('branch')).toBe(true)
  })

  it('falls back to the defaults on a damaged file or a field it does not know', () => {
    const path = file()
    writeFileSync(path, '{broken')
    expect(new StatusLineConfig(path).shows('cwd')).toBe(true)
    writeFileSync(path, '{"statusLine":"cwd"}')
    expect(new StatusLineConfig(path).shows('cwd')).toBe(true)
    writeFileSync(path, '{"statusLine":{"hide":["cwd","nonsense",7]}}')
    const config = new StatusLineConfig(path)
    expect(STATUS_FIELDS.filter((field) => !config.shows(field))).toEqual(['cwd'])
  })

  it('keeps a choice for this run when it cannot be written, and says so', () => {
    const config = new StatusLineConfig(undefined)
    expect(config.toggle('cwd')).toBe(false)
    expect(config.shows('cwd')).toBe(false)
  })
})

describe('StatusLinePicker', () => {
  const rig = (path = file(), locale = 'en') => {
    const picker = new StatusLinePicker({
      config: new StatusLineConfig(path),
      ansi: new TuiTheme('mono').ansi(createAnsi('none')),
      locale,
      changed: () => {},
    })
    return { picker, path, text: () => picker.render(80).join('\n') }
  }

  it('lists the fields with a box each, flips one with Space or Enter and saves at once', () => {
    const { picker, path, text } = rig()
    expect(text()).toBe('')
    picker.show()
    expect(text()).toContain('❯ [x] Model')
    expect(text()).toContain('[x] Extension status line')
    expect(text()).toContain('Always shown: budget warning, approval ticket, error notices')
    picker.handleInput(' ')
    expect(text()).toContain('❯ [ ] Model')
    picker.handleInput('\x1b[B')
    picker.handleInput('\r')
    expect(text()).toContain('❯ [ ] Preset')
    expect(json(path)).toEqual({ statusLine: { hide: ['model', 'preset'] } })
    for (let i = 0; i < 20; i++) picker.handleInput('\x1b[B')
    expect(text()).toContain('❯ [x] Extension status line')
    picker.handleInput('\x1b')
    expect(text()).toBe('')
  })

  it('takes every key while open, and none when closed', () => {
    const { picker } = rig()
    expect(picker.handleInput('x')).toBe(false)
    picker.show()
    expect(picker.handleInput('x')).toBe(true)
  })

  it('says when a choice could not be saved, and writes in Chinese', () => {
    const { picker, text } = rig(blocked(), 'zh-CN')
    picker.show()
    picker.handleInput(' ')
    expect(text()).toContain('未保存')
    expect(text()).toContain('[ ] 模型')
    expect(text()).toContain('始终显示：预算告警、审批暂存票、错误通知')
  })

  it('/statusline opens the list; /statusline reset shows every field again; anything else is refused', () => {
    const { picker, path, text } = rig()
    expect(picker.command([])).toBeUndefined()
    expect(text()).toContain('Status line')
    picker.handleInput(' ')
    expect(picker.command(['reset'])).toBe('Status line reset: every field is shown')
    expect(picker.config.shows('model')).toBe(true)
    expect(json(path)).toEqual({})
    expect(picker.command(['reset', 'now'])).toBe('usage: /statusline [reset]')
    expect(picker.command(['all'])).toBe('usage: /statusline [reset]')
    expect(rig(blocked()).picker.command(['reset'])).toContain('could not be written')
  })
})
