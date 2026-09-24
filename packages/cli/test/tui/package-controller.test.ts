import type { NodeClient } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { PackageController } from '../../src/tui/package-controller.js'

describe('TUI package controller', () => {
  it('cancels a preview locally before any install request is made', async () => {
    let installs = 0
    const client = {
      packages: {
        async list() {
          return { packages: [] }
        },
        async install() {
          installs++
          throw new Error('should not install')
        },
      },
    } as unknown as NodeClient
    const controller = new PackageController(client, () => 'local-dev')
    await expect(controller.install('cancel')).resolves.toBe('Installation cancelled.')
    await expect(controller.install('confirm')).resolves.toBe('No installation is awaiting confirmation.')
    expect(installs).toBe(0)
  })

  it('clears pending state when an invalid source fails before a chat prompt can be submitted', async () => {
    const controller = new PackageController({} as NodeClient, () => 'local-dev')
    await expect(controller.install('https://untrusted.example/package')).rejects.toThrow(/package source/)
    await expect(controller.install('confirm')).resolves.toBe('No installation is awaiting confirmation.')
  })

  it('uses the durable package receipt contract for lifecycle actions and operation recovery', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const receipt = { operationId: 'op-1', profile: 'local-dev' }
    const completed = {
      ...receipt,
      operation: 'rollback' as const,
      state: 'rolled-back' as const,
      progress: 100,
      startedAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:01.000Z',
    }
    const client = {
      clientId: async () => 'tui-client',
      packages: {
        list: async () => ({ packages: [] }),
        catalog: { list: async () => ({ items: [] }) },
        trust: async (params: Record<string, unknown>) => {
          calls.push({ method: 'trust', params })
          return receipt
        },
        enable: async (params: Record<string, unknown>) => {
          calls.push({ method: 'enable', params })
          return receipt
        },
        disable: async (params: Record<string, unknown>) => {
          calls.push({ method: 'disable', params })
          return receipt
        },
        update: async (params: Record<string, unknown>) => {
          calls.push({ method: 'update', params })
          return receipt
        },
        rollback: async (params: Record<string, unknown>) => {
          calls.push({ method: 'rollback', params })
          return receipt
        },
        remove: async (params: Record<string, unknown>) => {
          calls.push({ method: 'remove', params })
          return receipt
        },
        operation: {
          get: async (params: Record<string, unknown>) => {
            calls.push({ method: 'operation.get', params })
            return completed
          },
          cancel: async (params: Record<string, unknown>) => {
            calls.push({ method: 'operation.cancel', params })
            return receipt
          },
        },
      },
    } as unknown as NodeClient
    const controller = new PackageController(client, () => 'local-dev')

    await expect(controller.manage(['rollback', 'acme/pkg'])).resolves.toContain('rollback rolled-back')
    await expect(controller.manage(['operation', 'op-1'])).resolves.toContain('rollback rolled-back')
    await expect(controller.manage(['cancel', 'op-1'])).resolves.toBe('cancel accepted op-1')
    await expect(
      controller.manage(['trust', 'acme/pkg', `sha256-${'a'.repeat(64)}`, 'b'.repeat(64)]),
    ).resolves.toContain('rollback rolled-back')

    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'rollback',
          params: expect.objectContaining({
            profile: 'local-dev',
            clientId: 'tui-client',
            id: 'acme/pkg',
            commandId: expect.stringMatching(/^rollback-/),
          }),
        }),
        expect.objectContaining({
          method: 'operation.get',
          params: { profile: 'local-dev', operationId: 'op-1' },
        }),
        expect.objectContaining({
          method: 'operation.cancel',
          params: expect.objectContaining({ operationId: 'op-1' }),
        }),
        expect.objectContaining({
          method: 'trust',
          params: expect.objectContaining({ id: 'acme/pkg', capabilityHash: 'b'.repeat(64) }),
        }),
      ]),
    )
  })
})
