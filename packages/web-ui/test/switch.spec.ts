/**
 * AGH has one switch size. The shared `Switch` passes antd's `size` through, so the refinement layer has to give antd's
 * small switch the same proportions as the default one: a 38×22 track with an 18px knob centred against its end.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { build } from 'esbuild'
import { inCssLayer, readWebStyleSource, readWebUiStyleSource } from '../../../tools/web-style-source.mjs'

const root = resolve(import.meta.dirname, '../../..')
const css = [
  readWebStyleSource(resolve(root, 'packages/web/public/style.css')),
  inCssLayer(readFileSync(createRequire(import.meta.url).resolve('antd/dist/antd.css'), 'utf8'), 'vendor'),
  readWebUiStyleSource(resolve(root, 'packages/web-ui/src/tokens.css')),
].join('\n')
let fixture: string
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      loader: 'tsx',
      resolveDir: resolve(root, 'packages/web-ui'),
      contents: `
    import { createAntdRoot } from './src/antd-root.js'
    import { Switch } from './src/ui/switch.js'
    const sizes = [['default', undefined], ['small', 'small']]
    createAntdRoot(document.getElementById('fixture')).render(<div id="switches">{sizes.flatMap(([name, size]) =>
      [false, true].map((on) => <Switch key={name + on} size={size} defaultChecked={on} aria-label={name + (on ? ' on' : ' off')} />))}</div>)
  `,
    },
    bundle: true,
    write: false,
    jsx: 'automatic',
    format: 'iife',
  })
  if (!result.outputFiles[0]) throw new Error('No switch fixture')
  fixture = result.outputFiles[0].text
})

/** Track, knob, the knob's distance from the track's centre line and from the end it rests against. */
const geometry = (page: Page, label: string) =>
  page.getByRole('switch', { name: label, exact: true }).evaluate((node) => {
    const track = node.getBoundingClientRect()
    const knob = (node.querySelector('.ant-switch-handle') ?? node).getBoundingClientRect()
    const checked = node.getAttribute('aria-checked') === 'true'
    return {
      width: track.width,
      height: track.height,
      knob: { width: knob.width, height: knob.height },
      offCentre: knob.top + knob.height / 2 - (track.top + track.height / 2),
      inset: checked ? track.right - knob.right : knob.left - track.left,
    }
  })

type Styles = Record<string, Record<string, string>>
/** Every computed property of the track, the knob holder, the knob it draws and the inner text lane. */
const styles = (page: Page, label: string): Promise<Styles> =>
  page.getByRole('switch', { name: label, exact: true }).evaluate((node) => {
    const all = (element: Element, pseudo?: string) => {
      const style = getComputedStyle(element, pseudo)
      return Object.fromEntries([...style].map((name) => [name, style.getPropertyValue(name)]))
    }
    const handle = node.querySelector('.ant-switch-handle') ?? node
    return {
      track: all(node),
      handle: all(handle),
      knob: all(handle, '::before'),
      inner: all(node.querySelector('.ant-switch-inner') ?? node),
    }
  })
const differing = (left: Styles, right: Styles) =>
  Object.entries(left).flatMap(([part, values]) =>
    Object.keys(values)
      .filter((name) => values[name] !== right[part]?.[name])
      .map((name) => `${part} ${name}`),
  )

for (const theme of ['light', 'dark'] as const)
  test(`a small switch renders as AGH's one 38×22 switch with its 18px knob centred (${theme})`, async ({
    page,
  }) => {
    await page.setContent(`<html lang="en"${theme === 'dark' ? ' class="dark"' : ''}><head><title>Switch</title>
      <style>${css} body {display:block} #switches {display:flex;align-items:flex-start;gap:24px;padding:32px}</style></head>
      <body data-agnes-region="app"><div id="fixture"></div></body></html>`)
    await page.addScriptTag({ content: fixture })
    await expect(page.getByRole('switch')).toHaveCount(4)
    for (const state of ['off', 'on']) {
      const standard = await geometry(page, `default ${state}`)
      expect(standard).toEqual({
        width: 38,
        height: 22,
        knob: { width: 18, height: 18 },
        offCentre: 0,
        inset: 2,
      })
      expect(await geometry(page, `small ${state}`), `small ${state}`).toEqual(standard)
      // Nothing else differs either: every computed property of the track, knob and inner text lane is the same.
      // (Pixels are not compared: the knob's antialiased edge differs by a unit where the two sit on the page.)
      expect(differing(await styles(page, `small ${state}`), await styles(page, `default ${state}`))).toEqual(
        [],
      )
    }
  })
