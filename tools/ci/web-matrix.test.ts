import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildMatrices } from './web-matrix.mjs'

type Batch = { id: string; args: string[]; widths: string; timeoutMinutes: number }
type Group = { id: string; batches: [string, ...string[]] }
type Platform = { batches: [Batch, Batch, ...Batch[]]; groups: [Group, Group, ...Group[]] }
type Manifest = { macos: Platform; linux: Platform }
const manifest = (): Manifest =>
  JSON.parse(readFileSync(new URL('./web-batches.json', import.meta.url), 'utf8'))
it('packs every canonical selector once into sixteen Mac pairs and six Linux triples', () => {
  const source = manifest()
  const matrices = buildMatrices(source)
  for (const [platform, count, size] of [
    ['macos', 16, 2],
    ['linux', 6, 3],
  ] as const) {
    expect(matrices[platform].include).toHaveLength(count)
    const selected = matrices[platform].include.flatMap((group: { batches: unknown[] }) => {
      expect(group.batches).toHaveLength(size)
      return group.batches
    })
    expect(selected).toHaveLength(source[platform].batches.length)
    expect(new Set(selected.map((batch: { id: string }) => batch.id)).size).toBe(selected.length)
    expect(selected).toEqual(expect.arrayContaining(source[platform].batches))
  }
  const narrow = matrices.macos.include
    .flatMap((group: { batches: { id: string }[] }) => group.batches)
    .find((batch: { id: string }) => batch.id === 'narrow-phone')
  expect(narrow).toEqual({
    id: 'narrow-phone',
    args: ['narrow.spec.ts', '--grep', '375 en/light$'],
    widths: '375',
    timeoutMinutes: 10,
  })
})

it('refuses missing, repeated or unknown batch references and unsafe selector changes', () => {
  for (const mutate of [
    (m: Manifest) => m.macos.groups.pop(),
    (m: Manifest) => (m.macos.groups[0].batches[0] = m.macos.groups[1].batches[0]),
    (m: Manifest) => (m.linux.groups[0].batches[0] = 'unknown'),
    (m: Manifest) => (m.macos.batches[0].id = m.macos.batches[1].id),
    (m: Manifest) => m.macos.batches[0].args.push('--retries=1'),
    (m: Manifest) => (m.macos.batches[0].args = ['missing.spec.ts']),
    (m: Manifest) => m.macos.batches[0].args.push('--grep'),
    (m: Manifest) => (m.macos.batches[0].timeoutMinutes = 20),
    (m: Manifest) => (m.macos.batches[0].widths = '375'),
  ]) {
    const changed = manifest()
    mutate(changed)
    expect(() => buildMatrices(changed)).toThrow()
  }
})

it('lets the full nightly narrow matrix own the phone and tablet subsets exactly once', () => {
  const source = manifest()
  const matrices = buildMatrices(source, { nightly: true })
  for (const platform of ['macos', 'linux'] as const) {
    const selected = matrices[platform].include.flatMap((group: { batches: Batch[] }) => group.batches)
    expect(selected.map((batch: Batch) => batch.id)).not.toContain('narrow-phone')
    expect(selected.map((batch: Batch) => batch.id)).not.toContain('narrow-tablet')
    expect(selected).toHaveLength(source[platform].batches.length - 2)
    expect(selected).toEqual(
      expect.arrayContaining(source[platform].batches.filter((batch) => !batch.id.startsWith('narrow-'))),
    )
    expect(matrices[platform].include.every((group: { batches: Batch[] }) => group.batches.length > 0)).toBe(
      true,
    )
  }
})
