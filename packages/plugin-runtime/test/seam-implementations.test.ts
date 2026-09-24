import { Context } from '@agnes/cordis'
import { describe, expect, it } from 'vitest'
import {
  createMutableSeamImplementations,
  createSeamImplementations,
  DYNAMIC_SEAM_NAMES,
} from '../src/seam-implementations.js'

function implementation(label: string) {
  return Object.freeze({ read: () => label })
}

describe('Core seam composition', () => {
  it('keeps stable facades while Cordis providers change', async () => {
    const root = new Context()
    const disposers = DYNAMIC_SEAM_NAMES.map((name) =>
      root.provide(`seam:${name}`, implementation(`${name}:v1`)),
    )
    const seams = createSeamImplementations<
      Record<(typeof DYNAMIC_SEAM_NAMES)[number], ReturnType<typeof implementation>> & {
        sandbox: ReturnType<typeof implementation>
        platform: ReturnType<typeof implementation>
      }
    >(root, { sandbox: implementation('sandbox'), platform: implementation('platform') })
    const verifier = seams.verifier

    expect(verifier.read()).toBe('verifier:v1')
    await disposers[DYNAMIC_SEAM_NAMES.indexOf('verifier')]?.()
    expect(() => verifier.read()).toThrow(/seam is unavailable: verifier/)

    const disposeV2 = root.provide('seam:verifier', implementation('verifier:v2'))
    expect(seams.verifier).toBe(verifier)
    expect(verifier.read()).toBe('verifier:v2')

    await disposeV2()
    await Promise.all(disposers.map((dispose) => dispose()))
    await root.fiber.dispose()
  })

  it('fails closed when a required dynamic seam is missing', async () => {
    const root = new Context()
    await expect(async () =>
      createSeamImplementations(root, {
        sandbox: implementation('sandbox'),
        platform: implementation('platform'),
      }),
    ).rejects.toThrow(/E_SEAM_MISSING: approval/)
    await root.fiber.dispose()
  })
})

describe('Mutable seam composition across a runtime-target tree swap', () => {
  type Seams = Record<(typeof DYNAMIC_SEAM_NAMES)[number], ReturnType<typeof implementation>> & {
    sandbox: ReturnType<typeof implementation>
    platform: ReturnType<typeof implementation>
  }

  async function tree(generation: string) {
    const root = new Context()
    const disposers = DYNAMIC_SEAM_NAMES.map((name) =>
      root.provide(`seam:${name}`, implementation(`${name}:${generation}`)),
    )
    // Let the provide() service emission settle exactly like a real tree.apply() would.
    await Promise.resolve()
    return { root, disposers }
  }

  it('keeps the new generation alive when the previous tree is retired afterwards', async () => {
    const first = await tree('t1')
    const mutable = createMutableSeamImplementations<Seams>(first.root, {
      sandbox: implementation('sandbox'),
      platform: implementation('platform'),
    })
    expect(mutable.seams.principals.read()).toBe('principals:t1')

    // Publication moves the pointer synchronously; the old tree is closed asynchronously afterwards.
    const second = await tree('t2')
    mutable.replaceRoot(second.root)
    expect(mutable.seams.principals.read()).toBe('principals:t2')

    for (const dispose of first.disposers) await dispose()
    await first.root.fiber.dispose()

    // Nothing touched the live generation, so every dynamic facade must still resolve to it.
    for (const name of DYNAMIC_SEAM_NAMES) expect(mutable.seams[name].read()).toBe(`${name}:t2`)

    for (const dispose of second.disposers) await dispose()
    await second.root.fiber.dispose()
  })
})
