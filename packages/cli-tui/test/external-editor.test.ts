import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VStack } from '../src/component.js'
import { editInExternal, externalEditNotice, splitCommand } from '../src/external-editor.js'
import { Renderer } from '../src/renderer.js'
import { FakeTerminal } from '../src/terminal.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-edit-test-'))
  dirs.push(dir)
  return dir
}

// A real, non-interactive editor: node runs the script on the file it is given.
const node = (script: string): string =>
  `${JSON.stringify(process.execPath.split(sep).join('/'))} -e ${JSON.stringify(script)}`
const NL = 'String.fromCharCode(10)'

describe('splitCommand', () => {
  it('splits like a shell: spaces, quotes and backslashes, without running anything', () => {
    expect(splitCommand('code --wait')).toEqual(['code', '--wait'])
    expect(splitCommand(`"/Applications/My Editor/bin" -w 'a b' c\\ d ""`)).toEqual([
      '/Applications/My Editor/bin',
      '-w',
      'a b',
      'c d',
      '',
    ])
    expect(splitCommand('vim "a \\" b" $HOME `x`')).toEqual(['vim', 'a " b', '$HOME', '`x`'])
    expect(splitCommand('   ')).toEqual([])
  })
  it('keeps native Windows paths and applies Windows quote escaping without shell expansion', () => {
    expect(splitCommand(String.raw`C:\Windows\System32\notepad.exe`, 'windows')).toEqual([
      String.raw`C:\Windows\System32\notepad.exe`,
    ])
    expect(
      splitCommand(
        String.raw`"C:\Program Files\Editor\editor.exe" --wait "" "tail\\" "a\"b" %HOME%`,
        'windows',
      ),
    ).toEqual([String.raw`C:\Program Files\Editor\editor.exe`, '--wait', '', 'tail\\', 'a"b', '%HOME%'])
    expect(splitCommand(String.raw`C:\Editors\O'Neil\editor.exe`, 'windows')).toEqual([
      String.raw`C:\Editors\O'Neil\editor.exe`,
    ])
    expect(splitCommand('editor.exe "a""b"', 'windows')).toEqual(['editor.exe', 'a"b'])
    expect(splitCommand(String.raw`'C:\Program Files\Editor\editor.exe' --wait`, 'windows')).toEqual([
      String.raw`C:\Program Files\Editor\editor.exe`,
      '--wait',
    ])
  })
})

describe('editInExternal', () => {
  const run = (
    env: NodeJS.ProcessEnv,
    draft = 'draft',
    term = new FakeTerminal({ columns: 40, rows: 6 }),
  ) => {
    const tmpDir = scratch()
    const renderer = new Renderer(term, new VStack([]), false, { wheel() {}, copy() {} })
    renderer.start()
    const result = editInExternal(draft, { env, tmpDir, suspend: () => renderer.suspend() })
    return { result, tmpDir, term }
  }

  it('replaces the draft with the file on exit 0, from a private file that is gone afterwards', async () => {
    // POSIX mode bits are not a Windows ACL verdict; retain that assertion only on POSIX.
    const script = `const fs=require('fs');const f=process.argv[1];if(process.platform!=='win32'&&(fs.statSync(f).mode&0o777)!==0o600)throw Error('draft is not private');fs.writeFileSync(f,fs.readFileSync(f,'utf8').toUpperCase()+${NL})`
    const { result, tmpDir } = run({ EDITOR: node(script) }, 'hello\nworld')
    expect(await result).toEqual({ kind: 'edited', text: 'HELLO\nWORLD' })
    expect(readdirSync(tmpDir)).toEqual([])
  })

  it('prefers $VISUAL, and a non-zero exit keeps the draft and says so', async () => {
    const { result, tmpDir } = run({ VISUAL: node('process.exit(3)'), EDITOR: 'false' })
    expect(await result).toEqual({ kind: 'cancelled', code: 3 })
    expect(readdirSync(tmpDir)).toEqual([])
  })

  it('does not guess an editor, and reports one that cannot start', async () => {
    const { result: unset } = run({ VISUAL: '  ' })
    expect(await unset).toEqual({ kind: 'unset' })
    const { result: missing, tmpDir } = run({ EDITOR: join(scratch(), 'no-such-editor') })
    const failed = await missing
    expect(failed.kind).toBe('failed')
    expect(readdirSync(tmpDir)).toEqual([])
    expect(externalEditNotice(failed, 'en')?.text).toContain('Cannot run the editor')
    expect(externalEditNotice({ kind: 'unset' }, 'zh-CN')?.text).toContain('$EDITOR')
    expect(externalEditNotice({ kind: 'cancelled', code: 3 }, 'zh-CN')?.text).toContain('已取消')
    expect(externalEditNotice({ kind: 'edited', text: '' }, 'en')).toBeUndefined()
    if (sep === '\\') {
      const batch = run({ EDITOR: 'editor.cmd' })
      expect(await batch.result).toMatchObject({
        kind: 'failed',
        reason: expect.stringContaining('native .exe'),
      })
      expect(readdirSync(batch.tmpDir)).toEqual([])
    }
  })

  it('cleans the draft and interrupt handler when terminal suspension or restoration fails', async () => {
    const before = process.listeners('SIGINT')
    for (const failure of ['suspend', 'resume'] as const) {
      const tmpDir = scratch()
      const fail = () => {
        throw new Error(`fixture ${failure} failed`)
      }
      const result = await editInExternal('draft', {
        env: { EDITOR: node('0') },
        tmpDir,
        suspend: failure === 'suspend' ? fail : () => fail,
      })
      expect(result).toEqual({ kind: 'failed', reason: `fixture ${failure} failed` })
      expect(process.listeners('SIGINT')).toEqual(before)
      expect(readdirSync(tmpDir)).toEqual([])
    }
  })

  it('leaves the alternate screen, mouse, paste mode and raw mode while it runs, and restores each after', async () => {
    const { result, term } = run({ EDITOR: node('0') })
    const log: string[] = []
    const sent = term.writes.length
    const raw = { off: 0, on: 0 }
    const leave = term.leaveRaw.bind(term)
    const enter = term.enterRaw.bind(term)
    term.leaveRaw = () => {
      raw.off++
      leave()
    }
    term.enterRaw = () => {
      raw.on++
      enter()
    }
    await result
    const text = term.writes.slice(sent).join('')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte starts the mode switch
    for (const m of text.matchAll(/\x1b\[\?(1049|2004|1002)([hl])/g)) log.push(`${m[1]}${m[2]}`)
    // Each mode is switched off exactly once, before it is switched on again exactly once.
    for (const mode of ['1049', '2004', '1002']) {
      expect(log.filter((e) => e.startsWith(mode))).toEqual([`${mode}l`, `${mode}h`])
      expect(log.indexOf(`${mode}l`)).toBeLessThan(log.indexOf(`${mode}h`))
    }
    expect(raw).toEqual({ off: 1, on: 1 })
    expect(term.raw).toBe(true)
  })
})
