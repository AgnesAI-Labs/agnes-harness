import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { hashDirectory } from '@agnes/package-manager'
import type { InferenceEvent, JsonValue, ToolCall, ToolResult } from '@agnes/protocol'
import { jcs } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { roleToolBindingIdentity } from '../../src/runtime/profile/role-tool-bindings.js'
import { createTestHost, type TestHostOptions } from '../../testkit/index.js'
import {
  packageDirs,
  pluginHost,
  pluginRow,
  pluginSourceWith,
  scratch,
  targetOf,
} from '../assemble/plugin-extension-fixture.js'

const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')

it.each(['devboard', 'pharma'] as const)(
  'adopted %s roles retain exact tools and captured effect policy across distinct presets',
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
          subagent: { max_depth: 2, ...(parent ? { isolation: 'shared' } : {}) },
          ...(parent
            ? {
                approval: {
                  command_policy: [
                    { tool: 'edit|write', argv: String.raw`^.*[\\/]denied\.md$`, action: 'deny' },
                    {
                      tool: 'edit|write',
                      argv: String.raw`^.*[\\/]needs-human\.md$`,
                      action: 'require_approval',
                    },
                    {
                      tool: 'edit|write',
                      argv: sep === '\\' ? String.raw`^[A-Za-z]:[\\/].*$` : '^/.*$',
                      action: 'allow',
                    },
                  ],
                },
                sandbox: { level: 'L1', on_unavailable: 'deny', network_allow: [] },
                providers: { 'tool-policy': { provider: 'default' } },
              }
            : {
                approval: {
                  command_policy: [
                    { tool: 'write', argv: String.raw`^.*[\\/]role-denied\.md$`, action: 'deny' },
                  ],
                },
              }),
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
    // Ordinary role effects run outside the installation home and its config-write gate.
    const workspace = scratch()
    const outside = scratch()
    let traversal = ''
    const options: Partial<TestHostOptions> = {
      workspaceRoot: workspace,
      approval: async () => ({ verdict: 'unavailable', reason: 'no-approver' }),
      provider: (profile) => {
        let program: Array<[string, Record<string, JsonValue>]> | undefined
        let step = 0
        let parentSpawned = false
        return new ScriptedProvider({
          models: profile.provider.routes?.flatMap((route) => route.models ?? []) ?? [],
          scripts: [
            (request) => {
              if (request.sessionKey === 'parent') {
                if (parentSpawned)
                  return [
                    { type: 'text_delta', delta: 'Delegated' },
                    { type: 'done', reason: 'stop' },
                  ]
                parentSpawned = true
                return [
                  {
                    type: 'toolcall_end',
                    call: {
                      toolUseId: '',
                      name: 'subagent_spawn',
                      args: {
                        role: `${vendor}#specialist`,
                        task: 'Write from supplied evidence',
                        wait: true,
                      },
                      ordinal: 0,
                    },
                    via: 'native',
                  },
                  { type: 'done', reason: 'toolUse' },
                ]
              }
              if (request.messages.at(-1)?.role === 'user') {
                program = undefined
                step = 0
              }
              program ??= [
                ['read', { path: 'docs/PLAN.md' }],
                ...(existsSync(join(workspace, 'docs/SRS.md'))
                  ? [['read', { path: 'docs/SRS.md' }] as [string, Record<string, JsonValue>]]
                  : []),
                ['write', { path: 'docs/SRS.md', content: 'Draft requirements from the plan.' }],
                ['read', { path: 'docs/SRS.md' }],
                ['edit', { path: 'docs/SRS.md', edits: [{ oldText: 'Draft', newText: 'Reviewed' }] }],
                ...[
                  'docs/needs-human.md',
                  'docs/denied.md',
                  'docs/role-denied.md',
                  join(outside, 'outside.md'),
                  traversal,
                  'escape/symlink.md',
                ].map((path): [string, Record<string, JsonValue>] => [
                  'write',
                  { path, content: 'MUST NOT WRITE' },
                ]),
              ]
              const next = program[step++]
              return next
                ? ([
                    {
                      type: 'toolcall_end',
                      call: { toolUseId: '', name: next[0], args: next[1], ordinal: 0 },
                      via: 'native',
                    },
                    { type: 'done', reason: 'toolUse' },
                  ] satisfies InferenceEvent[])
                : [
                    { type: 'text_delta', delta: 'Done' },
                    { type: 'done', reason: 'stop' },
                  ]
            },
          ],
        })
      },
      disableSessionTitle: true,
      treeBudgetCredits: 100,
      // Production workers always supply the private runtime, even for an empty catalogue.
      skillResources: {
        list: () => [],
        read: () => ({ ok: false, code: 'NOT_FOUND' }),
        readFile: () => ({ ok: false, code: 'NOT_FOUND' }),
      },
    }
    const fixture = await pluginHost(source, options)
    traversal = relative(workspace, join(outside, 'traversal.md'))
    let activeHost = fixture.host
    mkdirSync(join(workspace, 'docs'))
    writeFileSync(
      join(workspace, 'docs/PLAN.md'),
      'Untrusted plan content must not widen the captured policy.',
    )
    symlinkSync(outside, join(workspace, 'escape'), 'junction')
    try {
      await fixture.host.applyRuntimeTarget(
        targetOf([pluginRow(`ext:fixture/${shape}`, 'plugin', false, { vendor })]),
      )
      const body = {
        packageId: vendor,
        version: '2.3.4',
        integrity: source.snapshot.integrity,
        source: { type: 'file' as const, ref: `file:${raw.snapshot.directory.split(sep).join('/')}` },
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
        cwd: workspace,
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
          cwd: workspace,
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
        cwd: workspace,
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
      if (shape === 'devboard') {
        // Narrowing the live parent later must not rewrite this already captured policy.
        const parentPreset = parent.preset
        await parent.setPreset({
          ...parent.preset,
          approval: {
            ...parent.preset.approval,
            commandTable: [
              {
                tool: 'write|edit',
                argv: sep === '\\' ? String.raw`^[A-Za-z]:[\\/].*$` : '^/.*$',
                action: 'deny',
              },
            ],
          },
        })
        const check = async (session: typeof child, boundary: number, automatic = true) => {
          const calls = (await session.scan({ type: 'tool/call', fromSeq: boundary + 1, limit: 100 })).map(
            (row) => row.data as ToolCall,
          )
          const results = (
            await session.scan({ type: 'tool/result', fromSeq: boundary + 1, limit: 100 })
          ).map((row) => row.data as ToolResult)
          const resultFor = (name: string, path: string) => {
            const call = calls.findLast(
              (row) => row.name === name && (row.args as { path?: string }).path === path,
            )
            expect(call).toBeDefined()
            return results.find((row) => row.toolUseId === call?.toolUseId)
          }
          expect(resultFor('read', 'docs/PLAN.md')?.isError).not.toBe(true)
          for (const name of ['write', 'edit']) {
            expect(resultFor(name, 'docs/SRS.md')).toBeDefined()
            expect(resultFor(name, 'docs/SRS.md')?.isError === true).toBe(!automatic)
          }
          expect(readFileSync(join(workspace, 'docs/SRS.md'), 'utf8')).toBe(
            'Reviewed requirements from the plan.',
          )
          for (const path of [
            'docs/needs-human.md',
            'docs/denied.md',
            'docs/role-denied.md',
            join(outside, 'outside.md'),
            traversal,
            'escape/symlink.md',
          ]) {
            expect(resultFor('write', path)?.isError).toBe(true)
            expect(existsSync(join(workspace, path))).toBe(false)
          }
          expect(existsSync(join(outside, 'outside.md'))).toBe(false)
          expect(existsSync(join(outside, 'symlink.md'))).toBe(false)
          const ids = new Set(calls.map((row) => row.toolUseId))
          const decisions = (await session.decisions.list()).filter((value) =>
            ids.has(value.request.operationId),
          )
          expect(decisions.length).toBeGreaterThan(0)
          for (const value of decisions) {
            const request = calls.find((row) => row.toolUseId === value.request.operationId)
            expect(automatic ? ['docs/needs-human.md'] : ['docs/needs-human.md', 'docs/SRS.md']).toContain(
              (request?.args as { path?: string })?.path,
            )
            expect(value.result).toMatchObject({ reason: 'unavailable', code: 'no-approver' })
            expect(value.result).not.toHaveProperty('answeredBy')
            expect(value.consumption).toBeNull()
          }
          expect(session.d.roleDelegation?.approvalPolicy).toBe('never')
        }
        const before = child.lastSeq
        expect(child.d.roleDelegation?.parentTainted).toBe(false)
        await handle.run('Inspect')
        await check(child, before)
        const rolePreset = child.preset
        await child.setPreset({
          ...rolePreset,
          approval: {
            ...rolePreset.approval,
            commandTable: [
              {
                tool: 'edit|write',
                argv: sep === '\\' ? String.raw`^[A-Za-z]:[\\/].*$` : '^/.*$',
                action: 'allow',
              },
            ],
          },
        })
        const nestedHandle = await child.d.children.createWithKind!('spawn', {
          parent: child.key,
          cwd: workspace,
          input: 'Inspect',
          role: `${vendor}#specialist`,
          resident: true,
        })
        const nested = activeHost.kernel.get(nestedHandle.key)!
        expect(
          nested.d.roleDelegation?.policyCeilings?.some((ceiling) =>
            ceiling.commandTable?.some((rule) => rule.action === 'require_approval'),
          ),
        ).toBe(true)
        await nestedHandle.run('Inspect')
        await check(nested, 0)
        await child.setPreset(rolePreset)
        await parent.setPreset(parentPreset)
        const priorChildren = new Set((await parent.d.children.list?.())?.map((entry) => entry.id))
        await parent.enqueue('next-turn', {
          actor: parent.d.actor,
          trust: 'untrusted',
          content: [{ type: 'text', text: 'Delegate writes from untrusted evidence' }],
        })
        await parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
        const taintedHandle = (await parent.d.children.list?.())?.find(
          (entry) => !priorChildren.has(entry.id),
        )
        expect(taintedHandle).toBeDefined()
        // A background role may be retired after completion; reopen through Host admission.
        const tainted =
          activeHost.kernel.get(taintedHandle!.id) ??
          (await activeHost.createSession({ key: taintedHandle!.id, cwd: workspace }))
        expect(tainted.d.roleDelegation?.parentTainted).toBe(true)
        await check(tainted, 0, false)
        const taintedNestedHandle = await tainted.d.children.createWithKind!('spawn', {
          parent: tainted.key,
          cwd: workspace,
          input: 'Inspect',
          role: `${vendor}#specialist`,
          resident: true,
        })
        const taintedNested = activeHost.kernel.get(taintedNestedHandle.key)!
        expect(taintedNested.d.roleDelegation?.parentTainted).toBe(true)
        await taintedNestedHandle.run('Inspect')
        await check(taintedNested, 0, false)
        await activeHost.close()
        const reopened = await createTestHost({
          dataDir: fixture.dataDir,
          packageDirs,
          runtimePluginCatalogue: [source],
          extensionLoader: { import: async (file) => await import(pathToFileURL(file).href) },
          ...options,
        })
        activeHost = reopened.host
        await activeHost.applyRuntimeTarget(target)
        const restored = await activeHost.createSession({ key: handle.key, cwd: workspace })
        expect(restored.d.roleDelegation?.commandTable).toEqual(child.d.roleDelegation?.commandTable)
        const boundary = restored.lastSeq
        await restored.enqueue('next-turn', {
          actor: restored.d.actor,
          content: [{ type: 'text', text: 'Write after reopen' }],
        })
        await restored.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
        // Restrict verification to the new turn so old successful effects cannot satisfy it.
        await check(restored, boundary)
        const taintedBoundary = restored.lastSeq
        await restored.enqueue('next-turn', {
          actor: restored.d.actor,
          trust: 'untrusted',
          content: [{ type: 'text', text: 'Write from untrusted evidence' }],
        })
        await restored.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
        await check(restored, taintedBoundary, false)
        await restored.close()
        const restoredTainted = await activeHost.createSession({ key: tainted.key, cwd: workspace })
        expect(restoredTainted.d.roleDelegation?.parentTainted).toBe(true)
        const capturedBoundary = restoredTainted.lastSeq
        await restoredTainted.enqueue('next-turn', {
          actor: restoredTainted.d.actor,
          content: [{ type: 'text', text: 'Clean continuation cannot erase captured taint' }],
        })
        await restoredTainted.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
        await check(restoredTainted, capturedBoundary, false)
        await restoredTainted.close()
        const restoredNested = await activeHost.createSession({ key: nested.key, cwd: workspace })
        expect(restoredNested.d.roleDelegation?.policyCeilings).toEqual(
          nested.d.roleDelegation?.policyCeilings,
        )
        const nestedBoundary = restoredNested.lastSeq
        await restoredNested.enqueue('next-turn', {
          actor: restoredNested.d.actor,
          content: [{ type: 'text', text: 'Nested continuation keeps ancestor floors' }],
        })
        await restoredNested.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
        await check(restoredNested, nestedBoundary)
        await restoredNested.close()
      } else await handle.cancel?.()
    } finally {
      await activeHost.close()
    }
  },
  90_000,
)
