import { mkdtemp, writeFile, rm } from 'node:fs/promises'
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
import { expect, it } from 'vitest'
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
      const controller = new PluginConfiguration({
        manager: {
          inventory: async () => ({ packages: [{ id: 'acme', directory }] }),
        } as unknown as PackageManager,
        profileDirectory: () => directory,
        store: () => store,
        clock: () => '2026-10-09T00:00:00Z',
        publish: async (artifact) => {
          if (refuse) throw new Error('probe refusal')
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
      expect((await controller.save(request, authority)).reason).toBe('refused')
      expect(store.configAudit.facts([rowId])).toEqual([])
      expect(store.desired()?.digest).toBe(initial.digest)
      refuse = false
      const results = await Promise.all([
        controller.save(request, authority),
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
      expect(decodeRuntimeTargetArtifact(store.desired()!).tree.rows).toEqual([])
      expect(store.configAudit.value('acme', rowId)).toEqual({ name: 'inactive', auth: 'secret://demo/key' })
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
