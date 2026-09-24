import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { listSourceFiles, repoRoot } from './repo.js'

// A literal control character in source is invisible in a diff and in review.
// This repo learned it twice: core wrote a NUL register-key separator raw instead
// of an escape, and later a NUL reached a host source file through a tool call and
// nobody saw it. Every byte below carries meaning somewhere here - NUL separates
// register keys, and the C1 range plus the line and paragraph separators each
// defeated a path guard's lookahead - so they must be written as escapes, where a
// reader can see them.
//
// Tab, newline and carriage return are excluded: they are ordinary formatting.
// The rule below assumes a control character in a pattern is an accident. Here it
// is the entire point, so the suppression sits on the line it applies to.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this guard exists to find them
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/

const files = listSourceFiles(repoRoot(), {
  excludeDirs: ['node_modules', 'dist', 'gen', 'generated'],
})

describe('no literal control characters in source', () => {
  it('scans a non-trivial number of files', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('every source file writes control characters as escapes', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const match = FORBIDDEN.exec(text)
      if (match) {
        const line = text.slice(0, match.index).split('\n').length
        const point = (match[0].codePointAt(0) ?? 0).toString(16).padStart(4, '0').toUpperCase()
        offenders.push(`${file}:${line} holds a literal U+${point}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
