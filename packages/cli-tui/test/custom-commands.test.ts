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
    mine(
      'review.md',
      '---\ndescription: "Review a file"\nargument-hint: <path>\n---\nReview $1 then say $@\n',
    )
    const app = appFor()
    expect(await runSlash(app, '/review src/a.ts now')).toEqual({
      prompt: 'Review src/a.ts then say src/a.ts now',
    })
    expect(slashCommandFor('/review', 'en', app)).toMatchObject({
      args: '<path>',
      description: 'Review a file',
    })
    expect(completeToken('/rev', app)).toEqual(['/review'])
    expect(completeToken('/re', app).at(-1)).toBe('/review')
    expect((await runSlash(app, '/review')).prompt).toBe('Review  then say')
  })

  it('shows a project command first and sends it on the second run only', async () => {
    project('ship.md', 'Run the build\u001b[2J and push $1')
    const app = appFor()
    const first = await runSlash(app, '/ship now')
    expect(first.prompt).toBeUndefined()
    expect(first.draft).toBe('/ship now')
    expect(first.text).toContain('.agh/commands/ship.md')
    expect(first.text).toContain('Run the build[2J and push now')
    expect(first.text).not.toContain('\u001b')
    expect(await runSlash(app, '/ship now')).toEqual({ prompt: 'Run the build\u001b[2J and push now' })
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

  it('refuses a project command that hides text in format characters', async () => {
    project('rtl.md', 'Summarise the diff\u202e and push')
    const app = appFor()
    for (const _ of [1, 2]) {
      const out = await runSlash(app, '/rtl')
      expect(out.prompt).toBeUndefined()
      expect(out.text).toContain('Not run: .agh/commands/rtl.md')
    }
  })

  it('puts built-ins first, then project over personal, and lists what it skipped in /help', async () => {
    project('help.md', 'x')
    project('both.md', 'project one')
    mine('both.md', 'personal one')
    mine('Bad_Name.md', 'x')
    mine('big.md', 'x'.repeat(32 * 1024 + 1))
    mine('ok-1.md', 'fine')
    symlinkSync(join(cwd, 'proj-secret'), join(personal, 'link.md'))
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

  it('reads at most 200 files per directory, and an empty expansion sends nothing', async () => {
    for (let i = 0; i < 210; i++) mine(`c${String(i).padStart(3, '0')}.md`, 'x')
    mine('a-empty.md', '$1')
    const app = appFor()
    expect((await runSlash(app, '/c198')).prompt).toBe('x')
    expect((await runSlash(app, '/c205')).text).toContain('unknown command')
    expect((await runSlash(app, '/a-empty')).text).toBe(tt('custom.empty', 'en', { name: '/a-empty' }))
  })
})
