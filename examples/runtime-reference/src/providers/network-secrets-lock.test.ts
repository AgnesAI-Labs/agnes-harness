import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  boundary,
  cleanup,
  consumer,
  error,
  must,
  resolveInput,
  scratch,
  secrets,
} from '../../../../packages/host/test/runtime/network-secrets-fixture.js'

describe.each(['network', 'secrets'])('%s independent implementation', (name) => {
  it('shares no implementation imports and fewer than half of whitespace-free lines', () => {
    const reference = readFileSync(fileURLToPath(new URL(`./${name}.ts`, import.meta.url)), 'utf8')
    const production = readFileSync(
      fileURLToPath(new URL(`../../../../packages/host/src/runtime/providers/${name}.ts`, import.meta.url)),
      'utf8',
    )
    expect(reference).not.toMatch(
      /(?:from|import\s*\()[^\n]*(?:packages\/host|providers\/network|providers\/secrets)/u,
    )
    const lines = (text: string) =>
      new Set(
        text
          .split('\n')
          .map((line) => line.replace(/\s/gu, ''))
          .filter(Boolean),
      )
    const a = lines(reference)
    const b = lines(production)
    const common = [...a].filter((line) => b.has(line)).length
    expect(common / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
  })
})

it('returns equivalent handle metadata, maintenance results and refusal codes for identical secret inputs', async () => {
  const root = scratch()
  const auth = boundary()
  const now = Date.now()
  const providers = ['default', 'reference'].map((kind) =>
    secrets(kind as 'default' | 'reference', `${root}/${kind}`, auth, { now: () => now }),
  )
  try {
    const results = []
    for (const broker of providers) {
      const locator = must(await broker.resolve(resolveInput, auth.call()))
      const { handleId: _handleId, ...metadata } = locator
      results.push({
        metadata,
        forged: error(await broker.use(locator, consumer, { ...auth.call() }, () => {})),
        audience: error(await broker.use(locator, { ...consumer, audience: 'other' }, auth.call(), () => {})),
        unauthorizedRotate: error(
          await broker.rotate({ secretId: 'credential', newVersionRef: 'secret://fixture/new' }, auth.call()),
        ),
        rotated: must(
          await broker.rotate(
            { secretId: 'credential', newVersionRef: 'secret://fixture/new' },
            auth.call({}, true),
          ),
        ),
        old: error(await broker.use(locator, consumer, auth.call(), () => {})),
        revoked: must(await broker.revoke({ secretId: 'credential', reason: 'test' }, auth.call({}, true))),
        afterRevoke: error(await broker.resolve(resolveInput, auth.call())),
      })
    }
    expect(results[0]).toEqual(results[1])
  } finally {
    for (const broker of providers) await broker.close()
    cleanup(root)
  }
})
