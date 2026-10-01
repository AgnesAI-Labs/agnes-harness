import { describe, expect, it } from 'vitest'
import { type AssemblyProvider, FixedCordisAssembly } from '../../src/runtime/cordis-adapter.js'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

function provider(
  overrides: Partial<AssemblyProvider> & Pick<AssemblyProvider, 'providerId' | 'contract'>,
): AssemblyProvider {
  return {
    major: 1,
    logicalName: 'default',
    scope: 'runtime',
    features: [],
    packageDigest: DIGEST_A,
    capabilities: [],
    requires: [],
    ...overrides,
  }
}

describe('container generations', () => {
  it('keeps a shared broker resource alive until every generation has released it', async () => {
    const stops: string[] = []
    let starts = 0
    const assembly = new FixedCordisAssembly([
      {
        key: 'mcp:shared',
        start: () => {
          starts += 1
          return () => {
            stops.push('mcp:shared')
          }
        },
      },
    ])
    await assembly.open({
      generationId: 'old',
      brokerKeys: ['mcp:shared'],
      providers: [provider({ providerId: 'old', contract: 'agh.old' })],
    })
    await assembly.open({
      generationId: 'next',
      brokerKeys: ['mcp:shared'],
      providers: [provider({ providerId: 'next', contract: 'agh.next', packageDigest: DIGEST_B })],
    })
    expect(starts).toBe(1)
    await assembly.close('next')
    expect(stops).toEqual([])
    expect(assembly.resourceRunning('mcp:shared')).toBe(true)
    await assembly.close('old')
    await assembly.close('old')
    expect(stops).toEqual(['mcp:shared'])
    expect(assembly.resourceRunning('mcp:shared')).toBe(false)
    expect(assembly.resourceStarts('mcp:shared')).toBe(1)
  })

  it('does not stop the previous generation when the next candidate fails ready', async () => {
    const stops: string[] = []
    const released: string[] = []
    const assembly = new FixedCordisAssembly([
      {
        key: 'mcp:shared',
        start: () => () => {
          stops.push('mcp:shared')
        },
      },
    ])
    await assembly.open({
      generationId: 'old',
      brokerKeys: ['mcp:shared'],
      providers: [
        provider({
          providerId: 'old',
          contract: 'agh.old',
          owners: [
            {
              id: 'old-owner',
              release: () => {
                released.push('old-owner')
              },
            },
          ],
        }),
      ],
    })
    await expect(
      assembly.open({
        generationId: 'next',
        brokerKeys: ['mcp:shared'],
        providers: [
          provider({
            providerId: 'next',
            contract: 'agh.next',
            ready() {
              throw new Error('interrupted')
            },
          }),
        ],
      }),
    ).rejects.toThrow('interrupted')
    expect(stops).toEqual([])
    expect(released).toEqual([])
    expect(assembly.resourceRunning('mcp:shared')).toBe(true)
    expect(assembly.invoke('old-run', 'old')).toMatchObject({ generationId: 'old', packageDigest: DIGEST_A })
  })

  it('keeps an already pinned run on its generation after a newer generation is published', async () => {
    let oldTokens = 0
    let nextTokens = 0
    const assembly = new FixedCordisAssembly()
    await assembly.open({
      generationId: 'old',
      providers: [
        provider({
          providerId: 'worker',
          contract: 'agh.worker',
          token: () => {
            oldTokens += 1
            return 'old'
          },
        }),
      ],
    })
    assembly.pinRun('run-old')
    await assembly.open({
      generationId: 'next',
      providers: [
        provider({
          providerId: 'worker',
          contract: 'agh.worker',
          packageDigest: DIGEST_B,
          token: () => {
            nextTokens += 1
            return 'next'
          },
        }),
      ],
    })
    expect(assembly.view('old').published).toBe(false)
    expect(assembly.view('old').state).toBe('ready')
    expect(assembly.invoke('run-old', 'worker')).toEqual({
      generationId: 'old',
      packageDigest: DIGEST_A,
      token: 'old',
    })
    expect(assembly.invoke('run-next', 'worker')).toEqual({
      generationId: 'next',
      packageDigest: DIGEST_B,
      token: 'next',
    })
    expect(oldTokens).toBe(1)
    expect(nextTokens).toBe(1)
  })

  it('refuses to cold-stop a pinned or busy generation, and rebuilds a cold one from the locked digest', async () => {
    const stops: string[] = []
    const mutable = provider({
      providerId: 'worker',
      contract: 'agh.worker',
      packageDigest: DIGEST_A,
    })
    const assembly = new FixedCordisAssembly([
      {
        key: 'mcp:shared',
        start: () => () => {
          stops.push('mcp:shared')
        },
      },
    ])
    await assembly.open({
      generationId: 'old',
      brokerKeys: ['mcp:shared'],
      providers: [mutable],
    })
    assembly.pinRun('run-old')
    await expect(assembly.coldStop('old')).rejects.toMatchObject({ code: 'busy' })
    expect(assembly.resourceRunning('mcp:shared')).toBe(true)
    expect(stops).toEqual([])

    assembly.beginInvocation('old', 'inv-1')
    assembly.unpinRun('run-old')
    await expect(assembly.coldStop('old')).rejects.toMatchObject({ code: 'busy' })
    assembly.finishInvocation('old', 'inv-1')
    ;(mutable as { packageDigest: string }).packageDigest = DIGEST_B
    await assembly.coldStop('old')
    expect(stops).toEqual(['mcp:shared'])
    expect(assembly.view('old').state).toBe('cold')
    expect(assembly.view('old').bindings[0]?.packageDigest).toBe(DIGEST_A)

    const recovered = await assembly.recover('old')
    expect(recovered.state).toBe('ready')
    expect(recovered.bindings[0]?.packageDigest).toBe(DIGEST_A)
    expect(assembly.resourceRunning('mcp:shared')).toBe(true)
    expect(assembly.resourceStarts('mcp:shared')).toBe(2)
    expect(assembly.invoke('rebuilt', 'worker').packageDigest).toBe(DIGEST_A)
    expect(mutable.packageDigest).toBe(DIGEST_B)
  })

  it('cold-stops one generation without stopping a broker resource another generation still holds', async () => {
    const stops: string[] = []
    const assembly = new FixedCordisAssembly([
      {
        key: 'mcp:shared',
        start: () => () => {
          stops.push('mcp:shared')
        },
      },
    ])
    await assembly.open({
      generationId: 'old',
      brokerKeys: ['mcp:shared'],
      providers: [provider({ providerId: 'old', contract: 'agh.old' })],
    })
    await assembly.open({
      generationId: 'next',
      brokerKeys: ['mcp:shared'],
      providers: [provider({ providerId: 'next', contract: 'agh.next', packageDigest: DIGEST_B })],
    })
    await assembly.coldStop('old')
    expect(stops).toEqual([])
    expect(assembly.resourceRunning('mcp:shared')).toBe(true)
    expect(assembly.view('next').state).toBe('ready')
    expect(assembly.invoke('still-next', 'next').generationId).toBe('next')
  })
})
