import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { detectTerminal, type SetupDeps, terminalSetupSlash } from '../src/terminal-setup-command.js'
import { appendShiftEnter, SHIFT_ENTER_JSON } from '../src/vscode-keybindings.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-setup-test-'))
  dirs.push(dir)
  return dir
}
const appWith = (kittyKeyboard: boolean) =>
  ({ locale: 'en', o: { term: { caps: { kittyKeyboard } } } }) as unknown as TuiApp
const deps = (env: NodeJS.ProcessEnv, dir = home()): SetupDeps => ({
  env,
  platform: 'linux',
  home: dir,
  now: () => new Date('2026-10-23T08:09:10Z'),
})
const run = async (env: NodeJS.ProcessEnv, line = '/terminal-setup', kitty = false) =>
  (await terminalSetupSlash(appWith(kitty), line, deps(env))).text ?? ''

describe('/terminal-setup guidance', () => {
  it.each([
    [{ TERM_PROGRAM: 'vscode' }, 'vscode'],
    [{ TERM_PROGRAM: 'vscode', CURSOR_TRACE_ID: 'x' }, 'cursor'],
    [{ TERM_PROGRAM: 'iTerm.app' }, 'iterm2'],
    [{ TERM_PROGRAM: 'tmux', LC_TERMINAL: 'iTerm2' }, 'iterm2'],
    [{ TERM_PROGRAM: 'WezTerm' }, 'wezterm'],
    [{ TERM: 'xterm-ghostty' }, 'ghostty'],
    [{ TERM: 'xterm-kitty' }, 'kitty'],
    [{ TERM: 'alacritty' }, 'alacritty'],
    [{ WT_SESSION: 'a' }, 'windows-terminal'],
    [{ TERM_PROGRAM: 'Apple_Terminal' }, 'apple-terminal'],
    [{ TERM: 'xterm-256color' }, 'other'],
  ] as const)('recognises %j as %s', (env, name) => expect(detectTerminal(env)).toBe(name))

  it('needs no setup where the kitty keyboard protocol is on', async () => {
    expect(await run({ TERM: 'xterm-ghostty' }, '/terminal-setup', true)).toMatch(
      /Ghostty .* no setup needed/,
    )
  })

  it('shows each other terminal its own configuration, ending in the ESC Return bytes', async () => {
    const alacritty = await run({ TERM: 'alacritty' })
    expect(alacritty).toContain('Detected Alacritty.')
    expect(alacritty).toContain('alacritty/alacritty.toml')
    expect(alacritty).toContain('chars = "\\u001b\\r"')
    expect(await run({ TERM_PROGRAM: 'iTerm.app' })).toContain('Send Hex Code')
    expect(await run({ TERM_PROGRAM: 'Apple_Terminal' })).toContain('Terminal.app')
    expect(await run({ WT_SESSION: 'a' })).toContain('"action": "sendInput"')
    // WezTerm reports the protocol but only when its own option is on: it still gets its key.
    expect(await run({ TERM_PROGRAM: 'WezTerm' }, '/terminal-setup', true)).toContain("SendString '\\x1b\\r'")
    // Inside tmux the protocol is off, so a kitty-family terminal around it needs its own key.
    const tmux = await run({ TMUX: '/tmp/x', TERM: 'tmux-256color', GHOSTTY_RESOURCES_DIR: '/g' })
    expect(tmux).toContain('keybind = shift+enter=text:\\x1b\\r')
    expect(tmux).toMatch(/Inside tmux or screen/)
  })

  it('falls back to the generic advice for a terminal it does not know, and rejects unknown arguments', async () => {
    expect(await run({})).toMatch(/not one agh recognises[\s\S]*Alt\+Enter/)
    expect(await run({}, '/terminal-setup nonsense')).toMatch(/^usage:/)
    expect(await run({ TERM: 'alacritty' }, '/terminal-setup apply')).toMatch(
      /only writes the setup for VS Code and Cursor/,
    )
  })
})

describe('/terminal-setup apply (VS Code and Cursor)', () => {
  const env = { TERM_PROGRAM: 'vscode' } as const
  const keybindings = (dir: string) => join(dir, '.config', 'Code', 'User', 'keybindings.json')
  const setup = (content?: string) => {
    const dir = home()
    mkdirSync(join(dir, '.config', 'Code', 'User'), { recursive: true })
    if (content !== undefined) writeFileSync(keybindings(dir), content)
    return { dir, path: keybindings(dir), deps: deps(env, dir), app: appWith(false) }
  }
  const backups = (dir: string) =>
    readdirSync(join(dir, '.config', 'Code', 'User')).filter((f) => f.includes('backup'))
  const original =
    '// Place your key bindings in this file to overwrite the defaults\n[\n  // mine\n  { "key": "ctrl+k", "command": "x" }, // keep\n]\n'

  it('shows a card, writes only after confirm, backs the old file up and only appends', async () => {
    const t = setup(original)
    const card = (await terminalSetupSlash(t.app, '/terminal-setup apply', t.deps)).text
    expect(card).toContain(`Will append one entry to ${t.path}`)
    expect(card).toContain('keybindings.json.agh-backup-20261023T080910Z')
    expect(readFileSync(t.path, 'utf8')).toBe(original)
    expect(backups(t.dir)).toEqual([])

    const done = (await terminalSetupSlash(t.app, '/terminal-setup confirm', t.deps)).text
    expect(done).toMatch(/Added the Shift\+Enter entry/)
    const written = readFileSync(t.path, 'utf8')
    // Everything that was there is still there, byte for byte, around the new entry.
    expect(written.startsWith(original.slice(0, original.indexOf('// keep') - 1))).toBe(true)
    expect(written).toContain('// mine')
    expect(written).toContain('// keep')
    expect(written).toContain('"args": { "text": "\\u001b\\r" }')
    const [backup] = backups(t.dir)
    expect(readFileSync(join(t.dir, '.config', 'Code', 'User', backup as string), 'utf8')).toBe(original)
    // A second run recognises its own entry.
    expect((await terminalSetupSlash(t.app, '/terminal-setup apply', t.deps)).text).toMatch(/already has/)
  })

  it('drops the card on cancel and does nothing on confirm without one', async () => {
    const t = setup(original)
    await terminalSetupSlash(t.app, '/terminal-setup apply', t.deps)
    await terminalSetupSlash(t.app, '/terminal-setup cancel', t.deps)
    expect((await terminalSetupSlash(t.app, '/terminal-setup confirm', t.deps)).text).toMatch(
      /no setup waiting/i,
    )
    expect(readFileSync(t.path, 'utf8')).toBe(original)
    expect(backups(t.dir)).toEqual([])
  })

  it('refuses when the file changed after the card was shown', async () => {
    const t = setup(original)
    await terminalSetupSlash(t.app, '/terminal-setup apply', t.deps)
    writeFileSync(t.path, '[]')
    expect((await terminalSetupSlash(t.app, '/terminal-setup confirm', t.deps)).text).toMatch(/changed since/)
    expect(readFileSync(t.path, 'utf8')).toBe('[]')
  })

  it.each([
    ['broken syntax', '[ { "key": ', /not a keybindings array/],
    ['not an array', '{ "a": 1 }', /not a keybindings array/],
    [
      'a different shift+enter sequence',
      '[{"key":"shift+enter","command":"workbench.action.terminal.sendSequence","args":{"text":"\\n"}}]',
      /different terminal sequence/,
    ],
  ])('writes nothing for %s', async (_name, content, message) => {
    const t = setup(content)
    expect((await terminalSetupSlash(t.app, '/terminal-setup apply', t.deps)).text).toMatch(message)
    expect(readFileSync(t.path, 'utf8')).toBe(content)
    expect(backups(t.dir)).toEqual([])
  })

  it('creates the file when only the settings directory exists, and refuses when that is missing too', async () => {
    const t = setup()
    expect((await terminalSetupSlash(t.app, '/terminal-setup apply', t.deps)).text).toMatch(/Will create/)
    expect((await terminalSetupSlash(t.app, '/terminal-setup confirm', t.deps)).text).toMatch(/Created/)
    expect(JSON.parse(readFileSync(t.path, 'utf8'))).toHaveLength(1)
    const bare = deps(env)
    expect((await terminalSetupSlash(t.app, '/terminal-setup apply', bare)).text).toMatch(
      /settings directory .* does not exist/,
    )
  })

  it('keeps a symlinked keybindings.json a link and replaces the file it points to', async () => {
    const t = setup()
    const real = join(t.dir, 'dotfiles-keybindings.json')
    writeFileSync(real, '[]')
    symlinkSync(real, t.path)
    await terminalSetupSlash(t.app, '/terminal-setup apply', t.deps)
    await terminalSetupSlash(t.app, '/terminal-setup confirm', t.deps)
    expect(lstatSync(t.path).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8'))).toHaveLength(1)
    expect(existsSync(`${real}.agh-${process.pid}.tmp`)).toBe(false)
  })
})

describe('appendShiftEnter', () => {
  const entry = `\n  ${SHIFT_ENTER_JSON}`
  const one = '[\n  { "key": "a", "command": "b" }'
  it.each([
    ['an empty array', '[]', '[]'],
    ['an empty array with a comment', '[ // none\n]', '[ // none\n]'],
    ['entries without a trailing comma', `${one}\n]`, `${one},\n]`],
    ['entries with a trailing comma and a comment', `${one}, // x\n]`, `${one}, // x\n]`],
    ['strings holding brackets and slashes', '[{ "c": "x]//[" }]', '[{ "c": "x]//[" },]'],
  ])('adds one entry to %s and changes nothing else', (_name, text, without) => {
    const result = appendShiftEnter(text)
    if ('refused' in result) throw new Error(result.refused)
    expect(result.text.replace(entry, '')).toBe(without)
    expect(appendShiftEnter(result.text)).toEqual({ refused: 'already' })
  })
})
