import { describe, expect, it } from 'vitest'
import { pluginTreeCommand } from '../src/commands/plugin-tree.js'
import { file, run } from './admin-harness.js'

const artifact = {
  encoding: 'base64',
  canonicalBase64: 'e30=',
  digest: 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  identity: {
    treeHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    resourceRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    compositeRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
}

describe('plugins tree and generations', () => {
  it('lists and shows the tree and the generations, one inert line each', async () => {
    const view = {
      actual: true,
      pending: false,
      desiredDigest: 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      workerGeneration: 3,
      desired: artifact,
    }
    const list = await run(pluginTreeCommand, ['plugins', 'tree'], { 'plugins.tree.list': () => view })
    expect(list.calls).toEqual([['plugins.tree.list', { profile: 'local-dev' }]])
    expect(list.out).toBe(
      'actual yes\tpending no\tdesired sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nworker generation 3\n',
    )
    const show = await run(pluginTreeCommand, ['plugins', 'tree', 'show', '--json'], {
      'plugins.tree.get': () => view,
    })
    expect(show.calls[0]?.[0]).toBe('plugins.tree.get')
    expect(JSON.parse(show.out).desired).toEqual(artifact)
    const gen = await run(pluginTreeCommand, ['plugins', 'generations'], {
      'plugins.generations': () => ({
        currentGenerationId: '11111111-1111-1111-1111-111111111111',
        generations: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            state: 'active',
            boundSessions: 2,
            openSessions: 1,
            live: true,
            packages: [{ id: 'p\u001b[1m', version: '1' }],
          },
        ],
        plugins: [],
      }),
    })
    expect(gen.out).toBe(
      'current 11111111-1111-1111-1111-111111111111\n11111111-1111-1111-1111-111111111111\tactive\tsessions 1/2\tlive\tp[1m@1\n',
    )
  })

  it('apply and rollback send nothing without --yes', async () => {
    const dry = await run(pluginTreeCommand, ['plugins', 'tree', 'apply', '--file', file(artifact)], {})
    expect(dry.calls).toEqual([])
    expect(dry.out).toContain(
      'Would apply plugin tree sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )
    const dryBack = await run(pluginTreeCommand, ['plugins', 'tree', 'rollback'], {})
    expect(dryBack.calls).toEqual([])
    expect(dryBack.out).toContain('Would roll the desired plugin tree back')
  })

  it('apply (artifact or a view holding it) and rollback send the matching request with --yes', async () => {
    const applied = await run(
      pluginTreeCommand,
      ['plugins', 'tree', 'apply', '--file', file({ desired: artifact }), '--yes'],
      {
        'plugins.tree.apply': () => ({
          desiredDigest: 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          pending: true,
        }),
      },
    )
    expect(applied.out).toBe(
      'applied sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tpending\n',
    )
    expect(applied.calls[0]?.[1]).toMatchObject({ profile: 'local-dev', artifact })
    const back = await run(pluginTreeCommand, ['plugins', 'tree', 'rollback', '--yes'], {
      'plugins.tree.rollback': () => ({ rolledBack: false }),
    })
    expect(back.out).toBe('nothing to roll back\n')
    expect(back.exit).toBe(1)
    const bad = await run(
      pluginTreeCommand,
      ['plugins', 'tree', 'apply', '--file', file({ nope: 1 }), '--yes'],
      {},
    )
    expect(bad.exit).toMatchObject({ name: 'UsageError' })
    expect(bad.calls).toEqual([])
  })
})
