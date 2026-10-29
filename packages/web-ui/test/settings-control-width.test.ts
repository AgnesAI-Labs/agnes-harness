import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const ui = readFileSync(resolve(root, 'packages/web-ui/src/components.css'), 'utf8')
const forms = readFileSync(resolve(root, 'packages/web/public/styles/17-settings-forms.css'), 'utf8')
/** The declarations of the first rule whose selector contains every given part. */
function rule(css: string, ...parts: string[]): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]?.replace(/\s+/g, ' ') ?? ''
    if (parts.every((part) => selector.includes(part))) return match[2] ?? ''
  }
  throw new Error(`no rule for ${parts.join(' + ')}`)
}

it('gives every settings row one control column that selects, fields, pickers and segments fill', () => {
  // The column: one width for every row, shrinking on narrow rows.
  const column = rule(ui, '.agnes-settings-item-control:has(')
  expect(column).toContain('flex: 0 1 260px')
  expect(column).toContain('width: 260px')
  // What fills it: selects, antd selects, text fields, segments, presets and the General pickers.
  const fill = rule(ui, '> .agnes-settings-item-control > :is(', '.agh-segmented', '.appearance-thumbs')
  expect(fill).toContain('width: 100%')
  for (const part of [
    'select',
    '.agnes-ui-select',
    '.agnes-settings-preset',
    '.appearance-picker',
    '.appearance-choices',
  ])
    expect(ui.slice(ui.indexOf('One control column for every settings row'))).toContain(part)
  // Switches, numbers and checkboxes are not stretched.
  expect(ui).toContain('input:not([type="checkbox"], [type="radio"], [type="number"])')
  // On a narrow screen the column is the whole row, under the name, for every such row alike.
  const narrow = ui.slice(ui.indexOf('On a narrow screen the control takes the whole row'))
  expect(narrow).toContain('width: 100%')
  expect(narrow).toContain('flex-basis: 100%')
  // Segments are equal; the General page's own segments and thumbnails line up too.
  expect(rule(ui, '.agnes-settings-item-control > .agh-segmented > .agh-segmented-option')).toContain(
    'flex: 1 1 0',
  )
  expect(rule(forms, '.agnes-settings-item-control > .appearance-choices > .appearance-option')).toContain(
    'flex: 1 1 0',
  )
  expect(rule(forms, '.agnes-settings-item-control > .appearance-thumbs')).toContain(
    'justify-content: space-between',
  )
  expect(rule(forms, '.appearance-picker > :is(.agnes-settings-input, .select-picker-trigger)')).toContain(
    'width: 100%',
  )
})

it('drops the account dialog title bar and dividers when the account form is a settings page', () => {
  // As specific as the dialog's own heading rule (an id inside :is), so it wins.
  expect(
    rule(
      forms,
      ':is(#account-dialog, .account-page-host) .account-dialog-body[data-page] .config-detail-heading',
    ),
  ).toContain('display: none')
  const grid = rule(forms, '.account-dialog-body[data-page] .config-detail-grid')
  expect(grid).toContain('padding: 0')
  const footer = rule(forms, '.account-dialog-body[data-page] .config-detail-footer')
  expect(footer).toContain('border-top: 0')
  expect(footer).toContain('background: transparent')
})

it('keeps 重新测试 beside any connection result and hides it while a test runs', () => {
  expect(rule(forms, '.account-status > #config-test')).toContain('display: none')
  const shown = rule(forms, '#config-error:not(:empty)', '> #config-test:not(:disabled')
  expect(shown).toContain('display: inline-flex')
  expect(forms).toContain('.account-status:has(> #config-state:not(:empty), > #config-error:not(:empty))')
})

it('shows the settings info icon as a plain help affordance, never the system help cursor', () => {
  // cursor: help draws an arrow with a question mark on macOS and Windows; the icon only explains.
  expect(rule(ui, '.agnes-settings-info')).toContain('cursor: default')
  expect(ui).not.toContain('cursor: help')
})
