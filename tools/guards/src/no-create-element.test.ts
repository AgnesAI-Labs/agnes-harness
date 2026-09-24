import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from './repo.js'

const root = repoRoot()

/**
 * Files migrated to the React component layer must not regress to imperative DOM.
 *
 * The component migration converts imperative DOM one file at a time. Each migrated file is appended to tools/guards/no-create-element.json;
 * from then on any `document.createElement` reintroduction (a hotfix copied from an old branch, an
 * AI edit falling back to familiar patterns) fails here instead of silently re-splitting the
 * codebase into two rendering styles. The list is append-only in practice: removing an entry means
 * the file either left the repo or genuinely stopped being a React-region file - both are review
 * decisions, not cleanup.
 *
 * Reverse-check: add an entry for any file that still contains `document.createElement` (e.g.
 * packages/web/src/app.ts) and this suite must go red.
 */

type Manifest = { files: string[] }

describe('migrated files stay free of document.createElement', () => {
  const manifest = JSON.parse(
    readFileSync(join(root, 'tools/guards/no-create-element.json'), 'utf8'),
  ) as Manifest

  it('manifest entries exist and contain no document.createElement', () => {
    const offenders: string[] = []
    for (const rel of manifest.files) {
      const abs = join(root, rel)
      let text: string
      try {
        text = readFileSync(abs, 'utf8')
      } catch {
        offenders.push(`${rel}: listed but missing from the repo`)
        continue
      }
      if (/document\.createElement\s*\(/.test(text)) offenders.push(`${rel}: document.createElement found`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('manifest paths are repo-relative and unique', () => {
    const seen = new Set<string>()
    const bad: string[] = []
    for (const rel of manifest.files) {
      if (rel.includes('\\')) bad.push(`${rel}: use forward slashes`)
      if (seen.has(rel)) bad.push(`${rel}: duplicate entry`)
      seen.add(rel)
    }
    expect(bad, bad.join('\n')).toEqual([])
  })
})
