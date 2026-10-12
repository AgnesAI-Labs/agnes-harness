import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const layers = join(dirname(fileURLToPath(import.meta.url)), '../packages/web-ui/src/layers.css')

export function inCssLayer(source, layer) {
  return `@layer ${layer} {\n${source}\n}\n`
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
    source.replace('@import "./components.css";', '') +
    '\n' +
    readUiCss(join(dirname(file), 'components.css'))
  )
}
