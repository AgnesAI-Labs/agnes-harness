import { readFileSync } from 'node:fs'
import type { AuthoringCandidate, PackagePreview } from '@agnes/protocol'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { candidateDiff } from '../src/admin/plugins/candidate-diff.js'
import { addedPermissions, CandidateDelta, capabilityLabel } from '../src/admin/plugins/candidate-review.js'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

it.each([
  [null, 'new\nfile\n'],
  ['deleted\nfile', null],
  ['start\nold\nkeep\nend', 'start\nnew\nkeep\nend'],
  ['same\nsame\nold', 'same\nnew\nsame'],
  ['text', 'text\n'],
  ['old\n'.repeat(1000), 'new\n'.repeat(1000)],
])('preserves both complete file versions in the line diff', (before, after) => {
  const lines = candidateDiff(before, after)
  expect(
    lines
      .filter((line) => line.kind !== 'added')
      .map((line) => line.text)
      .join('\n'),
  ).toBe(before ?? '')
  expect(
    lines
      .filter((line) => line.kind !== 'removed')
      .map((line) => line.text)
      .join('\n'),
  ).toBe(after ?? '')
})

const fixtures = readFileSync('packages/protocol/fixtures/package-admin/package-admin.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const candidate: AuthoringCandidate = fixtures.find(
  (row) => row.name === 'AuthoringCandidate' && row.kind === 'valid',
).payload
const preview: PackagePreview = fixtures.find(
  (row) => row.name === 'PackagePreview' && row.kind === 'valid',
).payload
const t = (key: string) => pluginAdminLocaleCatalog['zh-CN'][key] ?? key

it('keeps permission changes distinct from tool registration and exposes service grants without hash jargon', () => {
  const value = {
    ...candidate,
    preview: {
      ...preview,
      capabilityDiff: {
        ...preview.capabilityDiff,
        added: ['tools:sha256-' + 'a'.repeat(64), 'filesystem.write:/workspace', 'network:api.example.com'],
        serviceGrantsAdded: [{ extension: 'sample/service', name: 'records.write', range: '^1.0.0' }],
      },
    },
  }
  expect(addedPermissions(value)).toBe(3)
  expect(addedPermissions({ ...value, preview: null })).toBeUndefined()
  expect(capabilityLabel('tools:sha256-' + 'a'.repeat(64), t)).toBe('提供工具')
  const html = renderToStaticMarkup(<CandidateDelta value={value} t={t} />)
  expect(html).toContain('写入文件 · /workspace')
  expect(html).toContain('api.example.com')
  expect(html).toContain('records.write')
  expect(html).not.toContain('sha256-')
  expect(html).not.toContain('Host')
  const onlyTools = {
    ...value,
    preview: {
      ...value.preview,
      capabilityDiff: { ...preview.capabilityDiff, added: ['tools:sha256-' + 'a'.repeat(64)] },
    },
  }
  expect(addedPermissions(onlyTools)).toBe(0)
  expect(renderToStaticMarkup(<CandidateDelta value={onlyTools} t={t} />)).toContain('新增权限：无')
})
