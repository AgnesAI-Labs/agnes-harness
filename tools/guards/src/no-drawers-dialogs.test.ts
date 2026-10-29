// One way to open something (owner 2026-10-14, DESIGN.md 「v4 交互规范」): a page pushed in place, or
// a one-question ConfirmDialog. No right-side drawers and no large form dialogs. The files that still
// open a Drawer, Dialog or Modal are listed with a ceiling that only goes down; a new file or one more
// use fails. Removing a use needs no edit here, so windows converting pages in parallel never conflict.
import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTestFile, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
const allowance = JSON.parse(
  readFileSync(join(root, 'tools/guards/overlay-allowlist.json'), 'utf8'),
) as Record<string, number>

/** The primitives themselves: the dialog and drawer components, and the confirmation built on them. */
const PRIMITIVES = new Set([
  'packages/web-ui/src/ui/dialog.tsx',
  'packages/web-ui/src/ui/drawer.tsx',
  'packages/web-ui/src/ui/confirm-dialog.tsx',
])
const OVERLAY = /<(?:Drawer|Dialog|Modal)(?=[\s>/])/g

describe('pages open in place, not in drawers or form dialogs', () => {
  it('no file opens a new drawer or dialog, and no listed file opens more', () => {
    const over: string[] = []
    for (const file of listSourceFiles(join(root, 'packages'))) {
      const relative = file
        .slice(root.length + 1)
        .split(sep)
        .join('/')
      if (!/\.tsx$/.test(file) || isTestFile(file) || PRIMITIVES.has(relative)) continue
      const uses = readFileSync(file, 'utf8').match(OVERLAY)?.length ?? 0
      const limit = allowance[relative] ?? 0
      if (uses > limit) over.push(`${relative}: ${uses} > ${limit}`)
    }
    expect(over, 'open it as a PushPage, or ask one question with ConfirmDialog').toEqual([])
  })
})
