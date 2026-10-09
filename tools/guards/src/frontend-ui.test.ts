import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { frontendUiViolations } from './frontend-ui.js'
import { isTestFile, listSourceFiles, repoRoot } from './repo.js'

it('rejects untranslated presentation copy, layout styles and bypassed settings pages', () => {
  for (const code of [
    '<Button>Save</Button>',
    '<Button>{"保存"}</Button>',
    '<input placeholder="Find plugins"/>',
    'label.textContent = "Ready"',
    'window.confirm("Delete?")',
  ])
    expect(
      frontendUiViolations(code, 'packages/web/src/new.tsx').some((v) => v.rule === 'copy'),
      code,
    ).toBe(true)
  for (const code of ['<div style={{ gap: 12 }} />', '<div style={layout} />', 'node.style.display = "grid"'])
    expect(
      frontendUiViolations(code, 'packages/web/src/new.tsx').some((v) => v.rule === 'layout'),
      code,
    ).toBe(true)
  for (const code of [
    '<SearchPanel />',
    'createElement(BundlesPanel, {})',
    "import {SearchPanel as NewPanel} from './settings/search.js'; <NewPanel />",
  ])
    expect(frontendUiViolations(code, 'packages/web/src/app.ts')).toContainEqual(
      expect.objectContaining({ rule: 'settings' }),
    )
  expect(frontendUiViolations('<SearchPanel />', 'packages/web-admin/src/settings/registry.tsx')).toEqual([])
  expect(
    frontendUiViolations(
      '<Button>{t("save")}</Button><input data-testid="save"/>',
      'packages/web/src/new.tsx',
    ),
  ).toEqual([])
  expect(frontendUiViolations('// <Button>Save</Button>', 'packages/web/src/new.tsx')).toEqual([])
  expect(
    frontendUiViolations('<div style={{ gap: 12 }} />', 'packages/web-foundation/src/new.tsx'),
  ).toContainEqual(expect.objectContaining({ rule: 'layout' }))
})

it('keeps every frontend source inside the shared presentation boundaries', () => {
  const root = repoRoot()
  const violations: string[] = []
  for (const pkg of [
    'web',
    'web-conversation',
    'web-admin',
    'web-foundation',
    'web-ui',
    'web-client',
    'web-units',
  ]) {
    for (const file of listSourceFiles(join(root, 'packages', pkg, 'src')).filter(
      (file) => !isTestFile(file),
    )) {
      const source = readFileSync(file, 'utf8')
      const rel = relative(root, file)
      for (const violation of frontendUiViolations(source, rel))
        violations.push(
          `${rel}:${source.slice(0, violation.offset).split('\n').length} ${violation.rule}: ${violation.text}`,
        )
    }
  }
  expect(violations, violations.join('\n')).toEqual([])
})
