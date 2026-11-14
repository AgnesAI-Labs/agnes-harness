// Adapted from dsh-superagent (MIT)
/** Verifies that every class in src has a preceding JSDoc block. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

it('gives every class declaration in src a JSDoc block right before it', () => {
  const undocumented = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path))
    .flatMap((path) => {
      const text = readFileSync(join(SRC, path), 'utf8')
      return [
        ...text.matchAll(/^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/gm),
      ].flatMap((match) => {
        const before = text.slice(0, match.index).trimEnd()
        const start = before.lastIndexOf('/**')
        return start >= 0 && before.indexOf('*/', start) === before.length - 2
          ? []
          : [`src/${path}: ${match[1]}`]
      })
    })
  expect(undocumented).toEqual([])
})
