import { readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { isTestFile, listSourceFiles, presentationSourceFiles, repoRoot } from './repo.js'
import { newPresentationViolations, presentationCounts } from './ui-presentation.js'

const root = repoRoot()
const baseline = JSON.parse(
  readFileSync(join(root, 'tools/guards/ui-presentation-baseline.json'), 'utf8'),
) as {
  scope: string
  count: number
  files: Record<string, Record<string, number>>
}

it('blocks new internal classes/colors without blocking legacy pages, even at equal total counts', () => {
  const old = presentationCounts('<button class="secondary-button" style="color: #ffffff">Action</button>')
  expect(newPresentationViolations(old, old)).toEqual([])
  expect(
    newPresentationViolations(presentationCounts('<button class="primary-button">Action</button>'), old),
  ).toEqual(['internal-button-class:primary-button: 1 > 0'])
  expect(
    newPresentationViolations(
      presentationCounts('<button class="secondary-button secondary-button">Action</button>'),
      old,
    ),
  ).toEqual(['internal-button-class:secondary-button: 2 > 1'])
  expect(newPresentationViolations(presentationCounts('color: #123456'), old)).toEqual([
    'hex-color:#123456: 1 > 0',
  ])
  expect(
    presentationCounts(
      '/* .primary-button #fff */\n// .secondary-button\n<Button appearance="primary"/>; color: var(--agnes-text-primary)',
    ),
  ).toEqual({})
  expect(newPresentationViolations({}, old)).toEqual([])
})
it('ratchets business sources by file and literal; shared controls and token definitions own styling', () => {
  const files = [
    'web',
    'web-units',
    'web-admin',
    'web-conversation',
    'web-foundation',
    'web-client',
    'web-slots',
    'resource-control-web',
  ].flatMap((pkg) =>
    listSourceFiles(join(root, 'packages', pkg, 'src'), { extensions: ['.ts', '.tsx', '.css'] }),
  )
  files.push(
    ...presentationSourceFiles(root),
    ...listSourceFiles(join(root, 'packages/web/public'), { extensions: ['.html', '.css'] }).filter(
      (file) => basename(file) !== '01-tokens.css',
    ),
  )
  const errors: string[] = []
  for (const file of files.filter((file) => !isTestFile(file))) {
    const path = relative(root, file).replaceAll('\\', '/')
    errors.push(
      ...newPresentationViolations(
        presentationCounts(readFileSync(file, 'utf8')),
        baseline.files[path] ?? {},
      ).map((error) => `${path}: ${error}`),
    )
  }
  expect(baseline.scope.trim()).not.toBe('')
  expect(
    Object.values(baseline.files)
      .flatMap((counts) => Object.values(counts))
      .reduce((sum, count) => sum + count, 0),
  ).toBe(baseline.count)
  expect(errors, errors.join('\n')).toEqual([])
})
