import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { completeToken, runSlash, slashCommandFor } from '../src/commands.js'
import { expand } from '../src/custom-commands.js'
import { tt } from '../src/locale-extended.js'

let root: string
let cwd: string
let personal: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-custom-'))
  cwd = join(root, 'proj')
  personal = join(root, 'home', 'commands')
  mkdirSync(join(cwd, '.agh', 'commands'), { recursive: true })
  mkdirSync(personal, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const project = (file: string, text: string) => writeFileSync(join(cwd, '.agh', 'commands', file), text)
const mine = (file: string, text: string) => writeFileSync(join(personal, file), text)
const appFor = (remote = false) =>
  ({
    cwd,
    locale: 'en',
    refuseSwitch: () => false,
    o: { remote, commandsDir: personal },
    session: { id: 's', client: {} },
  }) as unknown as TuiApp

describe('custom slash commands', () => {
  it('expands $1..$9 and $@ in one pass', () => {
    expect(expand('a $1 b $2 c $@ d $3', ['x', '$1'])).toBe('a x b $1 c x $1 d ')
    expect(expand('$9 $0', ['x'])).toBe(' $0')
  })

  it('runs a personal command as a user message with no confirmation', async () => {
    mine('audit.md', '---\ndescription: "Review a file"\nargument-hint: <path>\n---\nReview $1 then say $@\n')
    const app = appFor()
    expect(await runSlash(app, '/audit src/a.ts now')).toEqual({
      prompt: 'Review src/a.ts then say src/a.ts now',
    })
    expect(slashCommandFor('/audit', 'en', app)).toMatchObject({
      args: '<path>',
      description: 'Review a file',
    })
    expect(completeToken('/aud', app)).toEqual(['/audit'])
    expect(completeToken('/au', app).at(-1)).toBe('/audit')
    expect((await runSlash(app, '/audit')).prompt).toBe('Review  then say')
  })

  it('reads frontmatter after a BOM and an empty frontmatter block', async () => {
    mine('bom.md', '\uFEFF---\ndescription: With BOM\n---\nbody one\n')
    mine('empty.md', '---\n---\nbody two\n')
    mine('rule.md', '---\n---\nabove\n---\nbelow\n')
    const app = appFor()
    expect(slashCommandFor('/bom', 'en', app)).toMatchObject({ description: 'With BOM' })
    expect(await runSlash(app, '/bom')).toEqual({ prompt: 'body one' })
    expect(await runSlash(app, '/empty')).toEqual({ prompt: 'body two' })
    expect(await runSlash(app, '/rule')).toEqual({ prompt: 'above\n---\nbelow' })
  })

  it('shows a project command first and sends it on the second run only', async () => {
    project('ship.md', 'Run the build and push $1')
    const app = appFor()
    const first = await runSlash(app, '/ship now')
    expect(first.prompt).toBeUndefined()
    expect(first.draft).toBe('/ship now')
    expect(first.text).toContain('.agh/commands/ship.md')
    expect(first.text).toContain('Run the build and push now')
    expect(await runSlash(app, '/ship now')).toEqual({ prompt: 'Run the build and push now' })
    // Changed content is a different command to the user: it asks again.
    project('ship.md', 'Delete everything')
    expect((await runSlash(app, '/ship')).prompt).toBeUndefined()
    expect(slashCommandFor('/ship', 'en', app)?.summary).toContain(
      tt('custom.project', 'en', { path: '.agh/commands/ship.md' }),
    )
  })

  it('previews only the first 200 characters', async () => {
    project('long.md', 'x'.repeat(500))
    const { text } = await runSlash(appFor(), '/long')
    expect(text).toContain('x'.repeat(200))
    expect(text).not.toContain('x'.repeat(201))
    expect(text).toContain('300 more characters not shown; read .agh/commands/long.md')
  })

  it('refuses a project command that holds characters the preview cannot show', async () => {
    const app = appFor()
    for (const hidden of [
      '\u001b[2J',
      '\u202e',
      '\u{E0100}',
      '\uFE00',
      '\u3164',
      '\u2800',
      '\u2028',
      '\u200b',
      '\u{E0041}',
      'a\uFE0F',
      'e\u0301\u0301\u0301\u0301',
    ]) {
      project('rtl.md', `Summarise the diff${hidden} and push`)
      for (const _ of [1, 2]) {
        const out = await runSlash(app, '/rtl')
        expect(out.prompt).toBeUndefined()
        expect(out.text).toContain('Not run: .agh/commands/rtl.md')
      }
    }
    // The emoji suffix carries nothing, so an emoji in a command is fine.
    project('ok.md', 'Ship it \u2764\uFE0F 1\uFE0F\u20E3 café 发布　完成')
    expect((await runSlash(app, '/ok')).text).toContain('.agh/commands/ok.md')
  })

  it('puts built-ins first, then project over personal, and lists what it skipped in /help', async () => {
    project('help.md', 'x')
    project('both.md', 'project one')
    mine('both.md', 'personal one')
    mine('Bad_Name.md', 'x')
    mine('big.md', 'x'.repeat(32 * 1024 + 1))
    mine('ok-1.md', 'fine')
    // Unprivileged Windows uses a directory junction; both links must be refused without reading them.
    symlinkSync(
      process.platform === 'win32' ? cwd : join(cwd, 'proj-secret'),
      join(personal, 'link.md'),
      process.platform === 'win32' ? 'junction' : 'file',
    )
    const app = appFor()
    const help = (await runSlash(app, '/help')).text ?? ''
    expect(help).toContain(tt('custom.skipped', 'en'))
    expect(help).toContain(`.agh/commands/help.md: ${tt('custom.builtin', 'en')}`)
    expect(help).toContain(`both.md: ${tt('custom.overridden', 'en')}`)
    expect(help).toContain(`Bad_Name.md: ${tt('custom.invalid', 'en')}`)
    expect(help).toContain(`big.md: ${tt('custom.size', 'en')}`)
    expect(help).toContain(`link.md: ${tt('custom.notFile', 'en')}`)
    expect(help).toContain('/ok-1')
    // /help is still the built-in one, and `both` is the project's.
    expect(help).toContain(tt('commands.helpHeading', 'en'))
    expect((await runSlash(app, '/both')).text).toContain('project one')
  })

  it('never reads the project directory over --connect, and picks up new files on the next run', async () => {
    project('only-here.md', 'x')
    mine('mine.md', 'personal')
    const remote = appFor(true)
    expect((await runSlash(remote, '/only-here')).text).toContain('unknown command')
    expect(await runSlash(remote, '/mine')).toEqual({ prompt: 'personal' })
    mine('later.md', 'new')
    expect(await runSlash(remote, '/later')).toEqual({ prompt: 'new' })
  })

  it('loads no personal or project command under --ignore-rules', async () => {
    project('only-here.md', 'x')
    mine('mine.md', 'personal')
    const app = { ...appFor(), o: { commandsDir: personal, noCustomCommands: true } } as unknown as TuiApp
    expect((await runSlash(app, '/only-here')).text).toContain('unknown command')
    expect((await runSlash(app, '/mine')).text).toContain('unknown command')
  })

  it('reads at most 200 files per directory, and an empty expansion sends nothing', async () => {
    for (let i = 0; i < 210; i++) mine(`c${String(i).padStart(3, '0')}.md`, 'x')
    mine('a-empty.md', '$1')
    const app = appFor()
    expect((await runSlash(app, '/c198')).prompt).toBe('x')
    expect((await runSlash(app, '/c205')).text).toContain('unknown command')
    expect((await runSlash(app, '/a-empty')).text).toBe(tt('custom.empty', 'en', { name: '/a-empty' }))
  })
})
