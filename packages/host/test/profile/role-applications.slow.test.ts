import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { hashDirectory } from '@agnes/package-manager'
import { jcs } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { roleToolBindingIdentity } from '../../src/runtime/profile/role-tool-bindings.js'
import { pluginHost, pluginRow, pluginSourceWith, targetOf } from '../assemble/plugin-extension-fixture.js'

const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')

it.each(['devboard', 'pharma'] as const)(
  'adopted %s roles retain their exact built-in and plugin tools across distinct presets',
  async (shape) => {
    const vendor = `@fixture/${shape}`
    const expected =
      shape === 'devboard'
        ? ['read', 'ls', 'find', 'grep', 'write', 'edit']
        : [
            'pharma_inspect',
            'pharma_dossier',
            'pharma_report',
            'present',
            'ask_user_question',
            'read',
            'ui_render',
            'skill_read',
            'pharma_record',
          ]
    const raw = pluginSourceWith(
      [
        {
          exportName: 'plugin',
          rowId: `ext:fixture/${shape}`,
          body: ['pharma_inspect', 'pharma_dossier', 'pharma_report', 'pharma_record']
            .map((name) => `ctx.tools.register(tool(${JSON.stringify(name)}))`)
            .join('\n'),
        },
      ],
      { vendor },
    )
    const entry = join(raw.snapshot.directory, 'index.js')
    writeFileSync(
      entry,
      `import { Type } from ${JSON.stringify(import.meta.resolve('@sinclair/typebox'))}\n` +
        readFileSync(entry, 'utf8').replace(
          "parameters: { type: 'object', properties: {}, additionalProperties: false }",
          'parameters: Type.Object({}, { additionalProperties: false })',
        ),
    )
    const file = join(raw.snapshot.directory, 'package.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    const bundle = (parent: boolean) => ({
      profile: {
        tools: [...expected, ...(parent ? ['subagent_spawn'] : [])],
        toolPolicy: { allow: [...expected, ...(parent ? ['subagent_spawn'] : [])] },
      },
      presets: {
        role: {
          name: 'role',
          extends: 'standard',
          ...(parent
            ? {
                subagent: { isolation: 'shared' },
                approval: { command_policy: [{ tool: 'edit|write', argv: '^/.*$', action: 'allow' }] },
                sandbox: { level: 'L1', on_unavailable: 'deny', network_allow: [] },
                providers: { 'tool-policy': { provider: 'default' } },
              }
            : {}),
          model: { system_prompt: { personaPrefix: parent ? 'COORDINATOR' : 'SPECIALIST' } },
        },
      },
      launch: {
        title: { en: parent ? 'Coordinator' : 'Specialist' },
        description: { en: 'Inspect the shared workspace with the declared role tools' },
        preset: 'role',
      },
    })
    manifest.agnes.bundles = { coordinator: bundle(true), specialist: bundle(false) }
    const declaration = {
      id: shape,
      agents: [`${vendor}#coordinator`, `${vendor}#specialist`],
      delegableAgents: [`${vendor}#specialist`],
    }
    manifest.agnes.application = declaration
    writeFileSync(file, JSON.stringify(manifest))
    const source = {
      ...raw,
      snapshot: { ...raw.snapshot, treeIntegrity: hashDirectory(raw.snapshot.directory, { exclude: [] }) },
    }
    const fixture = await pluginHost(source, {
      disableSessionTitle: true,
      treeBudgetCredits: 100,
      // Production workers always supply the private runtime, even for an empty catalogue.
      skillResources: {
        list: () => [],
        read: () => ({ ok: false, code: 'NOT_FOUND' }),
        readFile: () => ({ ok: false, code: 'NOT_FOUND' }),
      },
    })
    try {
      await fixture.host.applyRuntimeTarget(
        targetOf([pluginRow(`ext:fixture/${shape}`, 'plugin', false, { vendor })]),
      )
      const body = {
        packageId: vendor,
        version: '2.3.4',
        integrity: source.snapshot.integrity,
        source: { type: 'file' as const, ref: `file:${raw.snapshot.directory}` },
        signature: 'unverified' as const,
        declaration,
        declarationDigest: digest(declaration),
        dependencies: [],
        replacedRoles: [],
        dependencyDiff: {},
        assets: {},
        scope: 'fixture',
        recovery: 'fixture',
        warning: 'fixture',
      }
      const preview = { ...body, consentDigest: digest(body) }
      const config = createConfigurationService({
        home: fixture.dataDir,
        profile: 'local-dev',
        profileDir: join(fixture.dataDir, 'profiles/local-dev'),
      })
      if (!config.saveApplication) throw new Error('fixture lacks application adoption')
      await config.saveApplication({
        revision: 0,
        selection: {
          packageId: vendor,
          applicationId: shape,
          integrity: source.snapshot.integrity,
          declarationDigest: preview.declarationDigest,
          consentDigest: preview.consentDigest,
          bindingDigest: digest({}),
          consentSnapshot: preview,
        },
      })
      const parent = await fixture.host.createSession({
        key: 'parent',
        cwd: fixture.dataDir,
        agent: `${vendor}#coordinator`,
      })
      const builtin = parent.currentTools().resolve('read')
      if (!builtin?.executionBinding) throw new Error('fixture lacks built-in binding')
      const local = fixture.host.extensionRows
        .current()
        .find((row) => row.id === builtin.executionBinding?.rowId)
      if (!local) throw new Error('fixture lacks Host-owned extension row')
      expect(roleToolBindingIdentity(fixture.host, builtin)).toBeTruthy()
      const target = fixture.host.runtimeTargetSnapshot?.()
      if (!target) throw new Error('fixture lacks published target')
      for (const row of [
        { ...local, disabled: true },
        { ...local, config: { scope: 'different' } },
      ]) {
        expect(
          roleToolBindingIdentity(
            {
              ...fixture.host,
              runtimeTargetSnapshot: () => ({ ...target, tree: { ...target.tree, rows: [row] } }),
            },
            builtin,
          ),
        ).toBeUndefined()
      }
      expect(
        roleToolBindingIdentity(
          {
            ...fixture.host,
            runtimeTargetSnapshot: () => ({
              ...target,
              tree: { ...target.tree, rows: [...target.tree.rows, local] },
              resource: { ...target.resource, rows: { ...target.resource.rows, [local.id]: null } },
            }),
          },
          builtin,
        ),
      ).toBeUndefined()
      expect(
        roleToolBindingIdentity(fixture.host, {
          ...builtin,
          source: { ...builtin.source, trust: 'trusted' },
        }),
      ).toBeUndefined()
      const { runtimeTargetSnapshot: _published, ...localOnly } = fixture.host
      expect(roleToolBindingIdentity(localOnly, builtin)).toBeTruthy()
      if (!parent.d.children.createWithKind) throw new Error('fixture lacks role creation')
      await expect(
        parent.d.children.createWithKind('spawn', {
          parent: parent.key,
          cwd: fixture.dataDir,
          role: `${vendor}#specialist`,
          input: 'Filtered task',
          resident: true,
          toolFilter: { allow: [] },
        }),
      ).rejects.toThrow('child-tool-filter-denied')
      expect((await parent.scan({ type: 'x/host/role-tool-intersection', limit: 100 })).at(-1)).toMatchObject(
        {
          data: {
            tools: [],
            excluded: expect.arrayContaining(
              expected.map((tool) => ({ tool, reason: 'child-tool-filter-denied' })),
            ),
          },
        },
      )
      const handle = await parent.d.children.createWithKind('spawn', {
        parent: parent.key,
        cwd: fixture.dataDir,
        role: `${vendor}#specialist`,
        input: 'Inspect',
        resident: true,
      })
      const child = fixture.host.kernel.get(handle.key)
      if (!child) throw new Error('role child not opened')
      expect(child.d.roleDelegation?.tools.toSorted()).toEqual(expected.toSorted())
      expect(
        child
          .currentTools()
          .list()
          .map((tool) => tool.name)
          .toSorted(),
      ).toEqual(expected.toSorted())
      expect(
        (await parent.d.log.storage.scan(handle.key, { type: 'x/core/role-delegation', limit: 1 }))[0]?.data,
      ).toMatchObject({ tools: expect.arrayContaining(expected), approvalPolicy: 'never' })
      await handle.cancel?.()
    } finally {
      await fixture.host.close()
    }
  },
  90_000,
)
