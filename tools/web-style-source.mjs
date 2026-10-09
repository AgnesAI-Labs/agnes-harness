import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  return webStyleInputs(manifest)
    .slice(1)
    .map((file) => readFileSync(file, 'utf8'))
    .join('')
}
