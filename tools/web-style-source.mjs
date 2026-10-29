import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const xtermCss = require.resolve('@xterm/xterm/css/xterm.css', {
  paths: [join(import.meta.dirname, '../packages/web-ui')],
})

const layers = join(dirname(fileURLToPath(import.meta.url)), '../packages/web-ui/src/layers.css')

export function inCssLayer(source, layer) {
  return `@layer ${layer} {\n${source}\n}\n`
}

/** Vendor theme declarations are defaults; the ui layer owns their customization. */
export function readMarkdownThemeCss(file) {
  return readFileSync(file, 'utf8').replace(/\s*!important\b/g, '')
}

export function readUiCss(file) {
  return readFileSync(file, 'utf8').replace(/@import "\.\.?\/layers\.css";\s*/g, '')
}

/** Ordered source fragments; builds still emit the single public /style.css asset. */
export function webStyleInputs(manifest) {
  const file = typeof manifest === 'string' ? manifest : fileURLToPath(manifest)
  const lines = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/)
  const fragments = lines.map((line) => {
    const name = /^@import "\.\/styles\/([a-z0-9-]+\.css)";$/.exec(line)?.[1]
    if (!name) throw new Error('Invalid Web style source manifest')
    return join(dirname(file), 'styles', name)
  })
  return [file, ...fragments]
}

export function readWebStyleSource(manifest) {
  return (
    readFileSync(layers, 'utf8') +
    webStyleInputs(manifest)
      .slice(1)
      .map((file) => readFileSync(file, 'utf8'))
      .join('')
  )
}

/** Emit one theme-bridge asset, with public component CSS after the theme bridge. */
export function readWebUiStyleSource(file) {
  const source = readUiCss(file)
  return (
    inCssLayer(readFileSync(xtermCss, 'utf8'), 'vendor') +
    '\n' +
    source.replace('@import "./components.css";', '') +
    '\n' +
    readUiCss(join(dirname(file), 'components.css'))
      .replace('@import "./native.css";', '')
      .replace('@import "./doctor-groups.css";', '')
      .replace('@import "./mcp-tool-catalog.css";', '')
      .replace('@import "./refinement.css";', '') +
    '\n' +
    readUiCss(join(dirname(file), 'native.css')) +
    '\n' +
    readUiCss(join(dirname(file), 'doctor-groups.css')) +
    '\n' +
    readUiCss(join(dirname(file), 'mcp-tool-catalog.css')) +
    '\n' +
    // The refinement layer comes last so its proportions settle equal-specificity rules.
    readUiCss(join(dirname(file), 'refinement.css'))
  )
}
