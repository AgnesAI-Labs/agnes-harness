import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { systemPromptPlugin } from '@agnes/code'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { SystemPromptSettingsStore } from '@agnes/host-infrastructure/system-prompt-settings'
import { hashDirectory } from '@agnes/package-manager'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { type ApplicationPreview, type InferenceEvent, jcs, type RequestBody } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { pluginHost, pluginRow, pluginSourceWith, targetOf } from '../assemble/plugin-extension-fixture.js'

const vendor = '@fixture/roles'
const ref = (role: string) => `${vendor}#${role}`
const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
const text = (value: string): InferenceEvent[] => [
  { type: 'text_delta', delta: value },
  { type: 'done', reason: 'stop' },
]
const call = (name: string, ordinal = 0): InferenceEvent => ({
  type: 'toolcall_end',
  call: { toolUseId: '', name, args: name === 'writer_approval' ? { path: '/allowed-always' } : {}, ordinal },
  via: 'native',
})

function typedToolSource(directory: string): void {
  const entry = join(directory, 'index.js')
  const body = readFileSync(entry, 'utf8').replace(
    "parameters: { type: 'object', properties: {}, additionalProperties: false }",
    'parameters: Type.Object({}, { additionalProperties: false })',
  )
  writeFileSync(
    entry,
    `import { Type } from ${JSON.stringify(import.meta.resolve('@sinclair/typebox'))}\n${body}`,
  )
}

it('opens adopted roles fresh with their own requests, captured authority, absent-human refusal and signature refusal', async () => {
  const declaration = {
    id: 'role-fixture',
    defaultAgent: ref('assistant'),
    agents: ['assistant', 'reader', 'writer'].map(ref),
    delegableAgents: ['reader', 'writer'].map(ref),
  }
  const initial = pluginSourceWith(
    [
      {
        exportName: 'plugin',
        rowId: 'ext:fixture/roles',
        body: `
ctx.tools.register(tool('reader_marker'))
ctx.tools.register(tool('role_only'))
ctx.tools.register({ ...tool('writer_approval'), parameters: Type.Object({ path: Type.String() }), meta: { ...tool('writer_approval').meta, isReadOnly: false, commandArg: 'path', replay: 'never', requiresApproval: 'always' }, execute: async () => { throw new Error('APPROVAL MUST NOT EXECUTE') } })
ctx.tools.register({ ...tool('writer_signature'), execute: async (_args, ctx) => {
 const handle = await ctx.decisions.request({ key: 'sign', purpose: 'business.confirm', subject: { revision: 0 }, prompt: 'Sign?', options: ['allowed-once','rejected'], presentation: { en: {title:'Sign',fields:[],responseValue:'I sign.'} }, responseSchema: {type:'string',const:'I sign.'} })
 try { await ctx.decisions.wait(handle, {signal: ctx.signal}); throw new Error('SIGNATURE MUST NOT EXECUTE') }
 catch(error) { return {isError:true,content:[{type:'text',text:error.message}]} }
} })
`,
      },
    ],
    { vendor },
  )
  const file = join(initial.snapshot.directory, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const own = (role: string, tools: string[]) => ({
    profile: { tools, toolPolicy: { allow: tools } },
    presets: {
      role: {
        name: 'role',
        extends: 'standard',
        ...(role === 'assistant'
          ? { approval: { command_policy: [{ tool: 'writer_approval', argv: '^/.*$', action: 'allow' }] } }
          : {}),
        subagent: { max_depth: role === 'assistant' ? 1 : 4, max_fan_out: role === 'assistant' ? 4 : 8 },
        model: { system_prompt: { personaPrefix: `${role.toUpperCase()}_PERSISTENT_PERSONA` } },
      },
    },
    launch: {
      title: { en: role, 'zh-CN': role === 'reader' ? '读者' : '写者' },
      description: { en: `Use ${role} expertise` },
      preset: 'role',
    },
  })
  manifest.agnes.bundles = {
    assistant: own('assistant', [
      'reader_marker',
      'writer_approval',
      'writer_signature',
      'subagent_spawn',
      'subagent_list',
    ]),
    reader: own('reader', ['reader_marker']),
    writer: own('writer', ['writer_approval', 'writer_signature', 'role_only']),
  }
  manifest.agnes.application = declaration
  writeFileSync(file, JSON.stringify(manifest))
  typedToolSource(initial.snapshot.directory)
  const source = {
    ...initial,
    snapshot: {
      ...initial.snapshot,
      treeIntegrity: hashDirectory(initial.snapshot.directory, { exclude: [] }),
    },
  }
  const other = pluginSourceWith(
    [
      {
        exportName: 'plugin',
        rowId: 'ext:other/application',
        body: "ctx.tools.register(tool('other_marker'))",
      },
    ],
    { vendor: '@other/application', snapshotId: `sha256-${'6'.repeat(64)}` },
  )
  const otherFile = join(other.snapshot.directory, 'package.json')
  const otherManifest = JSON.parse(readFileSync(otherFile, 'utf8'))
  otherManifest.agnes.bundles = { reader: own('other', ['other_marker']) }
  otherManifest.agnes.application = {
    id: 'other',
    agents: ['@other/application#reader'],
    delegableAgents: ['@other/application#reader'],
  }
  writeFileSync(otherFile, JSON.stringify(otherManifest))
  typedToolSource(other.snapshot.directory)
  const otherSource = {
    ...other,
    snapshot: { ...other.snapshot, treeIntegrity: hashDirectory(other.snapshot.directory, { exclude: [] }) },
  }
  const requests: RequestBody[] = []
  const fixture = await pluginHost([source, otherSource], {
    packages: {
      '@agnes/code': {
        plugins: [
          {
            declaration: {
              id: 'system-prompt:default',
              export: 'systemPromptPlugin',
              apiRange: '^5.0.0',
              inject: ['providers'],
              runtime: 'in-process',
              default: true,
            },
            entry: normalizePluginExport(systemPromptPlugin),
          },
        ],
      },
    },
    disableSessionTitle: true,
    approval: async () => ({ verdict: 'unavailable', reason: 'no-approver' }),
    treeBudgetCredits: 100,
    allowed: ['standard', 'inspect'],
    presets: {
      inspect: {
        name: 'inspect',
        extends: 'standard',
        composition: { toolPolicy: { readOnly: true } },
      },
    },
    provider: (profile) =>
      new ScriptedProvider({
        models: profile.provider.routes?.flatMap((route) => route.models ?? []) ?? [],
        scripts: [
          (request) => {
            requests.push(request)
            if (
              !request.messages.some((message) => message.role === 'tool_result') &&
              request.system.includes('READER_PERSISTENT_PERSONA')
            )
              return [call('reader_marker'), { type: 'done', reason: 'toolUse' }]
            if (
              !request.messages.some((message) => message.role === 'tool_result') &&
              request.system.includes('WRITER_PERSISTENT_PERSONA')
            )
              return [
                call('writer_approval'),
                call('writer_signature', 1),
                { type: 'done', reason: 'toolUse' },
              ]
            return text('Findings ready; signed actions belong to the main assistant.')
          },
        ],
      }),
  })
  try {
    await fixture.host.applyRuntimeTarget(
      targetOf([
        ...fixture.host.extensionRows.current(),
        pluginRow('ext:fixture/roles', 'plugin', false, { vendor }),
        pluginRow('ext:other/application', 'plugin', false, {
          vendor: '@other/application',
          snapshotId: `sha256-${'6'.repeat(64)}`,
        }),
      ]),
    )
    const config = createConfigurationService({
      home: fixture.dataDir,
      profile: 'local-dev',
      profileDir: join(fixture.dataDir, 'profiles/local-dev'),
    })
    await new SystemPromptSettingsStore(fixture.profile.dataDir, fixture.profile.name).save({
      personaPrefix: 'PARENT_GLOBAL_PERSONA',
    })
    const parent = await fixture.host.createSession({
      key: 'role-parent',
      cwd: fixture.dataDir,
      agent: ref('assistant'),
    })
    const create = (role?: string, extra = {}) =>
      parent.d.children.createWithKind!('spawn', {
        parent: parent.key,
        cwd: fixture.dataDir,
        input: 'Inspect the evidence',
        resident: true,
        ...(role ? { role } : {}),
        ...extra,
      })
    for (const role of [ref('reader'), 'bread'])
      await expect(create(role)).rejects.toThrow('no roles are declared in this session; omit role')
    const body = {
      packageId: vendor,
      version: '2.3.4',
      integrity: source.snapshot.integrity,
      source: { type: 'file' as const, ref: `file:${initial.snapshot.directory.split(sep).join('/')}` },
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
    const preview: ApplicationPreview = { ...body, consentDigest: digest(body) }
    await config.saveApplication!({
      revision: 0,
      selection: {
        packageId: vendor,
        applicationId: declaration.id,
        integrity: source.snapshot.integrity,
        declarationDigest: preview.declarationDigest,
        consentDigest: preview.consentDigest,
        bindingDigest: digest({}),
        consentSnapshot: preview,
      },
    })
    await expect(fixture.host.resolveAgent?.('@other/application#reader')).resolves.toBeDefined()
    for (const role of ['@other/application#reader', ref('assistant'), 'bread'])
      await expect(create(role)).rejects.toThrow(
        `unknown role ${role}; available: ${declaration.delegableAgents!.join(', ')}`,
      )
    await expect(create(ref('reader'), { model: 'gw/m1' })).rejects.toThrow('cannot be combined')
    await expect(
      parent.d.children.createWithKind!('fork', {
        parent: parent.key,
        cwd: fixture.dataDir,
        input: 'x',
        role: ref('reader'),
      }),
    ).rejects.toThrow('cannot be combined')
    expect(await parent.d.children.list?.()).toEqual([])
    await parent.enqueue('next-turn', {
      content: [{ type: 'text', text: 'PARENT_CONVERSATION_SECRET subagent_spawn' }],
      actor: parent.d.actor,
    })
    const outcome = await parent.run({ until: 'turn-end', signal: AbortSignal.timeout(30_000) })
    expect(
      requests,
      JSON.stringify({
        outcome,
        tools: parent
          .currentTools()
          .list()
          .map((t) => t.name),
      }),
    ).not.toHaveLength(0)
    expect(
      requests
        .find((request) => request.sessionKey === parent.key)
        ?.tools.find((tool) => tool.name === 'subagent_spawn')?.description,
      JSON.stringify(requests.map((r) => ({ key: r.sessionKey, tools: r.tools.map((t) => t.name) }))),
    ).toContain(ref('reader'))
    expect(parent.d.registry.resolve('subagent_spawn')?.description).not.toContain(ref('reader'))
    await parent.setYolo(true, parent.d.actor)
    const reader = await parent.d.children.create({
      parent: parent.key,
      cwd: fixture.dataDir,
      input: 'Inspect the evidence',
      role: ref('reader'),
    })
    await reader.run('Inspect the evidence').catch(async (error) => {
      throw new Error(
        'reader failed ' + JSON.stringify(await parent.d.log.storage.scan(reader.key, { limit: 100 })),
        { cause: error },
      )
    })
    const request = requests.find((request) => request.sessionKey === reader.key)!
    expect(request.system).toContain('READER_PERSISTENT_PERSONA')
    expect(request.system).not.toContain('PARENT_GLOBAL_PERSONA')
    expect(JSON.stringify(request.messages)).not.toContain('PARENT_CONVERSATION_SECRET')
    expect(request.tools.map((tool) => tool.name)).toEqual(['reader_marker'])
    expect(
      JSON.stringify(await parent.d.log.storage.scan(reader.key, { type: 'tool/result', limit: 20 })),
    ).toContain('reader_marker')
    expect((await parent.d.log.storage.scan(reader.key, { type: 'session/start', limit: 1 }))[0]?.seq).toBe(1)
    expect(fixture.host.kernel.get(reader.key)?.d.log.parent).toBeUndefined()
    const writer = await create(ref('writer'))
    expect((await parent.scan({ type: 'x/host/role-tool-intersection', limit: 100 })).at(-1)).toMatchObject({
      origin: 'system',
      trust: 'trusted',
      data: { role: ref('writer'), excluded: [{ tool: 'role_only', reason: 'parent-tool-unavailable' }] },
    })
    await writer.run('Inspect the evidence').catch(async (error) => {
      throw new Error(
        'writer failed ' + JSON.stringify(await parent.d.log.storage.scan(writer.key, { limit: 100 })),
        { cause: error },
      )
    })
    const writerRequest = requests.find((request) => request.sessionKey === writer.key)!
    expect(writerRequest.system).toContain('WRITER_PERSISTENT_PERSONA')
    expect(writerRequest.tools.map((tool) => tool.name)).not.toContain('role_only')
    const decisions = await parent.d.log.storage.scan(writer.key, { type: 'decision/state', limit: 1000 })
    expect(
      decisions.length,
      JSON.stringify({
        tools: writerRequest.tools.map((tool) => tool.name),
        results: await parent.d.log.storage.scan(writer.key, { type: 'tool/result', limit: 1000 }),
      }),
    ).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(decisions)).toContain('delegated-approval-refused')
    expect(JSON.stringify(decisions)).not.toContain('"code":"full-access"')
    const results = JSON.stringify(
      await parent.d.log.storage.scan(writer.key, { type: 'tool/result', limit: 1000 }),
    )
    expect(results).toContain('hand this action back to the main assistant')
    expect(results).not.toContain('APPROVAL MUST NOT EXECUTE')
    expect(results).not.toContain('SIGNATURE MUST NOT EXECUTE')
    const captured = await parent.d.log.storage.scan(writer.key, { type: 'x/core/role-delegation', limit: 1 })
    expect(captured[0]?.data).toMatchObject({
      role: { ref: ref('writer') },
      approvalPolicy: 'never',
      permission: 'workspace-write',
    })
    const child = fixture.host.kernel.get(writer.key)!
    expect(child.d.actor).toEqual(parent.d.actor)
    expect(child.state.session?.delegation).toMatchObject({ kind: 'spawn', generationDepth: 1 })
    expect(child.preset.generationLimit).toBe(parent.preset.generationLimit)
    expect(child.preset.maxFanOut).toBe(parent.preset.maxFanOut)
    expect(child.yolo).toBe(false)
    await child.setYolo(true, parent.d.actor)
    expect(child.yolo).toBe(false)
    await parent.setYolo(false, parent.d.actor)
    await parent.setPreset({
      ...parent.preset,
      permission: 'read-only',
    })
    // Existing role sessions keep the captured snapshot after the parent's later switch.
    expect(child.permissionContext.policy).toBe('workspace-write')
    const readOnly = await create(ref('writer'), { input: 'Inspect read-only evidence' })
    await readOnly.run('Inspect read-only evidence')
    const readOnlyChild = fixture.host.kernel.get(readOnly.key)!
    expect(readOnlyChild.permissionContext.policy).toBe('read-only')
    await expect(readOnlyChild.setYolo(true, parent.d.actor)).rejects.toThrow('outside read-only isolation')
    expect(readOnlyChild.permissionContext.policy).toBe('read-only')
    expect(
      requests.find((request) => request.sessionKey === readOnly.key)?.tools.map((tool) => tool.name),
    ).not.toContain('writer_approval')
    expect(
      (await parent.d.log.storage.scan(readOnly.key, { type: 'x/core/role-delegation', limit: 1 }))[0]?.data,
    ).toMatchObject({ permission: 'read-only', approvalPolicy: 'never' })
    await readOnly.cancel!()
    await reader.cancel!()
    await writer.cancel!()
    await parent.close()
  } finally {
    await fixture.host.close()
  }
}, 120_000)
