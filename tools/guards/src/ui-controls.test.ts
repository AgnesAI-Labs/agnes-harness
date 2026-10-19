import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { expect, it } from 'vitest'
import { isTestFile, listSourceFiles, presentationSourceFiles, repoRoot } from './repo.js'
import { segmentedPresentationViolations } from './segmented-controls.js'
import { controlPresentationCounts, newControlPresentationViolations } from './ui-controls.js'

function segmentedErrors(root: string) {
  return [...new Set([...listSourceFiles(join(root, 'packages')), ...presentationSourceFiles(root)])]
    .map((file) => file.split(sep).join('/'))
    .filter(
      (file) =>
        !isTestFile(file) &&
        !/\/(?:test|tests)\//.test(file) &&
        !file.endsWith('/web-ui/src/ui/segmented.tsx'),
    )
    .flatMap((file) =>
      segmentedPresentationViolations(readFileSync(file, 'utf8')).map(
        (error) => `${relative(root, file).split(sep).join('/')}:${error}`,
      ),
    )
}

it('permits hidden/file fields and tokens, refuses new raw controls and all colour literal forms', () => {
  expect(
    controlPresentationCounts('<input type="hidden"><input type="file">color: var(--agnes-text-primary)'),
  ).toEqual({})
  for (const source of [
    '<input type="text">',
    '<select>',
    "doc.createElement('select')",
    '#abc',
    'rgb(1,2,3)',
    'hsl(0 0% 0%)',
    'color: red',
    'fill: tomato',
    'border: 1px solid rebeccapurple',
  ])
    expect(newControlPresentationViolations(controlPresentationCounts(source), {})).toHaveLength(1)
  const baseline = controlPresentationCounts('<input type="number">')
  expect(newControlPresentationViolations(baseline, baseline)).toEqual([])
  expect(
    newControlPresentationViolations(
      controlPresentationCounts('<input type="number"><input type="number">'),
      baseline,
    ),
  ).toHaveLength(1)
  expect(newControlPresentationViolations(controlPresentationCounts('<select>'), baseline)).toHaveLength(1)
})
it('keeps existing call sites explicit and forbids new raw controls or colours outside web-ui', () => {
  const root = repoRoot()
  const baseline = JSON.parse(
    readFileSync(join(root, 'tools/guards/ui-controls-baseline.json'), 'utf8'),
  ) as Record<string, Record<string, number>>
  const files = [
    ...new Set([
      ...listSourceFiles(join(root, 'packages'), { extensions: ['.ts', '.tsx', '.css', '.html', '.mjs'] }),
      ...presentationSourceFiles(root),
    ]),
  ]
  const errors = files
    .map((file) => file.split(sep).join('/'))
    .filter((file) => !isTestFile(file) && !file.includes('/web-ui/') && !/\/(?:test|tests)\//.test(file))
    .flatMap((file) => {
      const path = relative(root, file).split(sep).join('/')
      return newControlPresentationViolations(
        controlPresentationCounts(readFileSync(file, 'utf8')),
        baseline[path] ?? {},
      ).map((error) => `${path}: ${error}`)
    })
  expect(errors, errors.join('\n')).toEqual([])
})

it('reserves segmented presentation for fixed 2–5 short choices and permits descriptive radiogroups', () => {
  expect(
    segmentedPresentationViolations(
      `<SettingsGroup role="radiogroup" className="agnes-settings-choices"><SettingsChoice label="Long title" hint="Source, version, capabilities" /></SettingsGroup>`,
    ),
  ).toEqual([])
  expect(
    segmentedPresentationViolations(
      `<Segmented options={[{value: 'a', label: 'A'}, {value: 'b', label: 'B'}]} />`,
    ),
  ).toEqual([])
  for (const source of [
    `<div role="radiogroup" className="custom-segmented" />`,
    `<Segmented options={plugins.map(plugin => ({value: plugin.id, label: plugin.title}))} />`,
    `<Segmented options={[{value: 'a', label: 'A'}]} />`,
    `<Segmented options={[{value:'a'}, {value:'b'}, {value:'c'}, {value:'d'}, {value:'e'}, {value:'f'}]} />`,
    `<Segmented options={[{value: 'a', label: 'A', description: 'Details'}, {value: 'b', label: 'B'}]} />`,
    `<Segmented options={[{value: 'a', label: 'This is a very long option label'}, {value: 'b', label: 'B'}]} />`,
  ])
    expect(segmentedPresentationViolations(source), source).not.toEqual([])
  const fixture = mkdtempSync(join(tmpdir(), 'agh-segmented-sources-'))
  try {
    const directory = join(fixture, 'packages/package-manager/bundled-plugins/deliverables-ui/src')
    mkdirSync(directory, { recursive: true })
    for (const extension of ['ts', 'js', 'mjs'])
      writeFileSync(
        join(directory, `review-segmented.${extension}`),
        "import { createElement } from 'react'\nimport { Segmented } from '@agnes/web-ui'\n" +
          "export const reviewSegmented = () => createElement(Segmented, {options:[{value:'a'},{value:'b'},{value:'c'},{value:'d'},{value:'e'},{value:'f'}]})\n",
      )
    const errors = segmentedErrors(fixture)
    expect(errors).toHaveLength(3)
    for (const extension of ['ts', 'js', 'mjs'])
      expect(errors).toContain(
        `packages/package-manager/bundled-plugins/deliverables-ui/src/review-segmented.${extension}:3: Segmented requires 2–5 fixed options (found 6)`,
      )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
it('guards segmented presentation without forcing descriptive option lists into Segmented', () => {
  const root = repoRoot()
  const errors = segmentedErrors(root)
  expect(errors, errors.join('\n')).toEqual([])
})
