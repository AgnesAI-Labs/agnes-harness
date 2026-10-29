import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { headsUpSlash } from './heads-up.js'
import { tt } from './locale-extended.js'
import { STATUS_FIELDS } from './statusline-config.js'
import { displayWidth } from './terminal.js'
import { thinkingMode } from './thinking.js'

type Row = {
  name: string
  /** The value in force; a source that cannot be read gives `-`. */
  value(app: TuiApp): string | Promise<string>
  /** A command that changes it, shown in the table. */
  example: string
}

const onOff = (app: TuiApp, on: boolean): string => tt(on ? 'status.on' : 'status.off', app.locale)

// Every row only reads state the owning controller already keeps; the changing stays in its own command.
const ROWS: readonly Row[] = [
  { name: 'theme', value: (app) => app.themes.current, example: '/theme dark' },
  { name: 'borders', value: (app) => app.borders.mode, example: '/borders ascii' },
  { name: 'images', value: (app) => onOff(app, app.images.switchedOn), example: '/images off' },
  {
    name: 'vim',
    value: (app) => (app.editor.vim ? onOff(app, app.editor.vim.enabled) : '-'),
    example: '/vim on',
  },
  { name: 'notify', value: (app) => app.notify.mode, example: '/notify off' },
  { name: 'mouse', value: (app) => onOff(app, app.renderer.mouseReporting), example: '/mouse' },
  {
    name: 'thinking',
    value: (app) => tt(thinkingMode.expanded ? 'config.open' : 'config.folded', app.locale),
    example: '/thinking',
  },
  { name: 'todos', value: (app) => app.planPanel.currentMode, example: '/todos hide' },
  {
    name: 'statusline',
    value: (app) => {
      const hidden = STATUS_FIELDS.filter((field) => !app.statusLine.config.shows(field))
      return hidden.length === 0
        ? tt('config.allShown', app.locale)
        : tt('config.hidden', app.locale, { fields: hidden.join(', ') })
    },
    example: '/statusline',
  },
  { name: 'title', value: (app) => app.windowTitle.mode, example: '/title cwd' },
  { name: 'raw', value: (app) => onOff(app, app.raw.on), example: '/raw' },
  {
    name: 'heads-up',
    // The state lives in the session, so it is asked for; an answer that is neither on nor off shows `-`.
    value: async (app) => {
      const text = (await headsUpSlash(app, '/heads-up')).text
      return text === tt('headsUp.on', app.locale)
        ? onOff(app, true)
        : text === tt('headsUp.off', app.locale)
          ? onOff(app, false)
          : '-'
    },
    example: '/heads-up on',
  },
]

/**
 * `/config`: one table of the TUI preferences kept in other commands. `/config NAME [VALUE]` runs `/NAME [VALUE]`
 * as typed, so nothing is set, stored or picked here.
 */
export async function configSlash(
  app: TuiApp,
  args: readonly string[],
  run: (line: string) => Promise<SlashResult>,
): Promise<SlashResult> {
  const { locale } = app
  const [name, ...rest] = args
  if (name !== undefined) {
    if (!ROWS.some((row) => row.name === name))
      return { text: tt('config.usage', locale, { names: ROWS.map((row) => row.name).join('|') }) }
    return run(['/' + name, ...rest].join(' '))
  }
  const values = await Promise.all(
    ROWS.map(async (row) => {
      try {
        return await row.value(app)
      } catch {
        return '-'
      }
    }),
  )
  const table = [
    [tt('config.name', locale), tt('config.value', locale), tt('config.change', locale)],
    ...ROWS.map((row, i) => [row.name, values[i] as string, row.example]),
  ]
  const widths = [0, 1].map((col) => Math.max(...table.map((cells) => displayWidth(cells[col] as string))))
  return {
    text: table
      .map((cells) =>
        cells
          .map((cell, col) =>
            col < 2 ? cell + ' '.repeat((widths[col] as number) - displayWidth(cell)) : cell,
          )
          .join('  ')
          .trimEnd(),
      )
      .join('\n'),
    presentation: 'transcript',
  }
}
