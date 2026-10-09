import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompositeTargetStore } from '@agnes/daemon-foundation/storage/composite-target-store'
import type { PackageManager } from '@agnes/package-manager'
import {
  buildRuntimeTarget,
  createPluginRow,
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { expect, it, vi } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { PluginConfiguration } from '../src/packages/plugin-config.js'

it.each([false, true])(
  'fences concurrent saves, rejects bad configuration and commits redacted facts (resource-owned: %s)',
  async (resourceOwned) => {
    const directory = await mkdtemp(join(tmpdir(), 'plugin-config-'))
    const tables = sqliteTables()
    try {
      const rowId = resourceOwned ? 'ext:agnes/skills' : 'ext:acme/agent'
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          agnes: {
            plugins: [
              {
                export: 'main',
                id: rowId,
                apiRange: '^1.4.0',
                configReload: 'live',
                configSchema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'auth'],
                  properties: {
                    name: { type: 'string', minLength: 1 },
                    auth: { type: 'string', 'x-secret': true },
                  },
                },
              },
            ],
          },
        }),
      )
      const store = new CompositeTargetStore(tables.table('composite'), 'default')
      const initial = encodeRuntimeTargetArtifact(
        buildRuntimeTarget({
          rows: [
            createPluginRow({
              id: rowId,
              plugin: 'acme@1/main',
              snapshotDigest: '1',
              exportName: 'main',
              entryRevision: '1',
              extrasRevision: 'none',
              mountRevision: '1',
              config: { name: 'old', auth: 'secret://demo/old' },
            }),
          ],
          resources: { mcp: [], skills: {} },
          resourceRevision: '0'.repeat(64),
          compositeRevision: '0'.repeat(64),
        }),
      )
      store.publishDesired(initial)
      let refuse = false
      let applyGate: Promise<void> | undefined
      let offered!: () => void
      let liveRequest: boolean | undefined
      const controller = new PluginConfiguration({
        manager: {
          inventory: async () => ({ packages: [{ id: 'acme', directory }] }),
        } as unknown as PackageManager,
        profileDirectory: () => directory,
        store: () => store,
        clock: () => '2026-10-09T00:00:00Z',
        acknowledgementTimeoutMs: 10_000,
        publish: async (artifact, liveConfig) => {
          liveRequest = liveConfig
          offered?.()
          await applyGate
          if (refuse) {
            const error = new Error('Synthetic configuration refusal secret://demo/new token=hidden')
            error.name = 'PluginConfigRefused'
            throw error
          }
          store.publishDesired(artifact)
        },
      })
      const authority = {
        audience: 'admin' as const,
        principalId: 'admin-1',
        clientId: 'web',
        permissions: ['packages.activate' as const],
      }
      const request = {
        profile: 'default',
        id: 'acme',
        rowId,
        expectedRevision: initial.digest,
        value: { name: 'new', auth: 'secret://demo/new' },
        clientId: 'web',
        commandId: 'first',
      }
      const invalid = await controller.save(
        { ...request, value: { name: '', auth: 'synthetic-plaintext' } },
        authority,
      )
      expect(invalid.reason).toBe('invalid')
      expect(invalid.issues).toContainEqual({ path: '/name', code: 'minLength' })
      expect(JSON.stringify(invalid)).not.toContain('synthetic-plaintext')
      expect(store.desired()?.digest).toBe(initial.digest)
      refuse = true
      const refusal = await controller.save(request, authority)
      expect(refusal).toMatchObject({ ok: false, reason: 'refused', revision: initial.digest })
      expect(refusal.refusalReason).toContain('Synthetic configuration refusal')
      expect(JSON.stringify(refusal)).not.toMatch(/secret:\/\/|hidden/)
      expect(store.configAudit.facts([rowId])).toEqual([])
      expect(store.desired()?.digest).toBe(initial.digest)
      refuse = false
      let accept!: () => void
      applyGate = new Promise<void>((resolve) => {
        accept = resolve
      })
      const applying = new Promise<void>((resolve) => {
        offered = resolve
      })
      const first = controller.save(request, authority)
      await applying
      expect(liveRequest).toBe(true)
      expect(store.desired()?.digest).toBe(initial.digest)
      expect(store.configAudit.facts([rowId])).toEqual([])
      accept()
      applyGate = undefined
      const results = await Promise.all([
        first,
        controller.save(
          { ...request, commandId: 'second', value: { ...request.value, name: 'concurrent' } },
          authority,
        ),
      ])
      expect(results.map((result) => result.reason)).toEqual(['saved', 'conflict'])
      const decoded = decodeRuntimeTargetArtifact(store.desired()!)
      const active = resourceOwned ? decoded.resource.rows['ext:agnes/skills'] : decoded.tree.rows[0]
      expect(active?.config).toEqual(request.value)
      expect(active?.configReload).toBe('live')
      const facts = store.configAudit.facts([rowId])
      expect(facts).toEqual([
        expect.objectContaining({
          who: 'admin-1',
          when: '2026-10-09T00:00:00Z',
          before: { name: 'old', auth: '[redacted]' },
          after: { name: 'new', auth: '[redacted]' },
        }),
      ])
      expect(JSON.stringify(facts)).not.toContain('secret://')
      expect(store.configAudit.value('acme', rowId)).toEqual(request.value)
      // An intervening non-config publication is fenced again inside the SQLite transaction.
      store.configAudit.stage(initial.digest, initial.digest, 'stale', facts[0]!)
      expect(() => store.publishDesired(initial)).toThrow('E_PLUGIN_CONFIG_CONFLICT')
      expect(store.desired()?.digest).toBe(results[0]?.revision)
      store.configAudit.clear()
      const firstRevision = store.desired()!.digest
      const changed = await controller.save(
        {
          ...request,
          expectedRevision: firstRevision,
          commandId: 'back-old',
          value: { name: 'old', auth: 'secret://demo/old' },
        },
        authority,
      )
      const restored = await controller.save(
        { ...request, expectedRevision: changed.revision, commandId: 'back-new' },
        authority,
      )
      expect(restored.reason).toBe('saved')
      expect(restored.revision).not.toBe(firstRevision)
      expect(
        (
          await controller.save(
            { ...request, expectedRevision: firstRevision, commandId: 'stale-aba' },
            authority,
          )
        ).reason,
      ).toBe('conflict')
      expect(
        new CompositeTargetStore(tables.table('composite'), 'default').configAudit.value('acme', rowId),
      ).toEqual(request.value)
      // A bounded response may be pending; a late refusal must still leave facts and revision intact.
      vi.useFakeTimers()
      try {
        let release!: () => void
        applyGate = new Promise<void>((resolve) => {
          release = resolve
        })
        const started = new Promise<void>((resolve) => {
          offered = resolve
        })
        refuse = true
        const beforeTimeout = store.desired()!.digest
        const beforeAudit = store.configAudit.facts([rowId])
        const waiting = controller.save(
          {
            ...request,
            expectedRevision: beforeTimeout,
            commandId: 'timeout',
            value: { ...request.value, name: 'slow' },
          },
          authority,
        )
        await started
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await waiting).toMatchObject({ ok: false, reason: 'pending', revision: beforeTimeout })
        expect(store.configAudit.facts([rowId])).toEqual(beforeAudit)
        expect(store.desired()?.digest).toBe(beforeTimeout)
        release()
        // The next request stays behind the late refusal, then observes the original revision.
        expect(
          (
            await controller.save(
              { ...request, expectedRevision: beforeTimeout, commandId: 'after-timeout' },
              authority,
            )
          ).reason,
        ).toBe('saved')
        expect(store.desired()?.digest).toBe(beforeTimeout)
        expect(store.configAudit.facts([rowId])).toEqual(beforeAudit)
      } finally {
        applyGate = undefined
        refuse = false
        vi.useRealTimers()
      }
      // Installed but inactive entries retain revisioned values without mounting their code.
      const unmounted = encodeRuntimeTargetArtifact(
        buildRuntimeTarget({
          rows: [],
          resources: { mcp: [], skills: {} },
          resourceRevision: '0'.repeat(64),
          compositeRevision: '1'.repeat(64),
        }),
      )
      store.publishDesired(unmounted)
      expect((await controller.get({ profile: 'default', id: 'acme' })).entries[0]?.value).toEqual(
        request.value,
      )
      const inactive = await controller.save(
        {
          ...request,
          expectedRevision: unmounted.digest,
          commandId: 'inactive',
          value: { name: 'inactive', auth: 'secret://demo/key' },
        },
        authority,
      )
      expect(inactive.reason).toBe('saved')
      expect(liveRequest).toBe(false)
      expect(decodeRuntimeTargetArtifact(store.desired()!).tree.rows).toEqual([])
      expect(store.configAudit.value('acme', rowId)).toEqual({ name: 'inactive', auth: 'secret://demo/key' })
      // Next-session saves do not request a live apply even for an enabled row.
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      manifest.agnes.plugins[0].configReload = 'next-session'
      await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
      store.publishDesired(initial)
      const nextSession = await controller.save(
        { ...request, commandId: 'next-session', expectedRevision: initial.digest },
        authority,
      )
      expect(nextSession).toMatchObject({ ok: true, reason: 'saved', reload: 'next-session' })
      expect(liveRequest).toBe(false)
      // A manifest row name never authorizes overwriting another installed package's row.
      const foreign = encodeRuntimeTargetArtifact(
        buildRuntimeTarget({
          rows: [
            createPluginRow({
              id: rowId,
              plugin: 'other@1/main',
              snapshotDigest: '1',
              exportName: 'main',
              entryRevision: '1',
              extrasRevision: 'none',
              mountRevision: '1',
              config: request.value,
            }),
          ],
          resources: { mcp: [], skills: {} },
          resourceRevision: '0'.repeat(64),
          compositeRevision: '2'.repeat(64),
        }),
      )
      store.publishDesired(foreign)
      expect(
        (
          await controller.save(
            { ...request, expectedRevision: foreign.digest, commandId: 'foreign' },
            authority,
          )
        ).reason,
      ).toBe('refused')
      expect(store.desired()?.digest).toBe(foreign.digest)
    } finally {
      await tables.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
