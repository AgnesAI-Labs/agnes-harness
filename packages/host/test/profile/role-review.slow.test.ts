import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { bindMcpResourceServer, type McpConnection } from '@agnes/base'
import { hasChildControl } from '@agnes/core'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { hashDirectory } from '@agnes/package-manager'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import { type ApplicationPreview, type InferenceEvent, jcs, type RequestBody } from '@agnes/protocol'
import { createSkillCandidateRegistry, createSkillCordisService } from '@agnes/resource-control-runtime'
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

const vendor = '@fixture/review-role'
const ref = (name: string) => `${vendor}#${name}`
const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
const refused = (row: { data: unknown }) =>
  !!row.data && typeof row.data === 'object' && 'isError' in row.data && row.data.isError === true

async function setup(
  requestCall?: { name: string; args: Record<string, unknown> },
  configured = false,
  resource?: 'mcp' | 'skill',
  recheck: {
    commonResources?: boolean
    skillFiles?: boolean
    readVia?: 'ptc' | 'deferred'
    emptyTools?: 'parent' | 'role'
    deferred?: boolean
    disclose?: boolean
    liveMcp?: boolean
    stableSkills?: boolean
    scopedRuntimeSkill?: boolean
    warmedBridge?: 'ptc' | 'deferred'
    config?: 'same' | 'canonical' | 'absent-empty'
  } = {},
) {
  const raw = pluginSourceWith(
    [
      {
        exportName: 'plugin',
        rowId: 'ext:fixture/review-role',
        body: `
${
  recheck.readVia
    ? `ctx.tools.register({...tool('file_bridge'), meta: {...tool('file_bridge').meta, deferLoading: ${recheck.readVia === 'deferred'}}, execute: async (_args, ctx) => {
 const path = "__ROLE_SKILL_FILE__"
 ${recheck.readVia === 'ptc' ? `const reply = await createBridge(ctx)({jsonrpc: '2.0', id: 'role-file', method: 'bridge.tools.invoke', params: {name: 'read', args: {path}}}); return {content: [{type: 'text', text: JSON.stringify(reply)}], isError: 'error' in reply}` : `return ctx.tools.invoke('read', {path})`}
}})`
    : ''
}
ctx.tools.register(tool('common_read'))
ctx.tools.register(tool('role_only'))
ctx.tools.register({ ...tool('bridge'), execute: async (_args, ctx) => ctx.tools.invoke('role_only', {}) })
ctx.tools.register({ ...tool('ptc_bridge'), execute: async (_args, ctx) => {
 const reply = await createBridge(ctx)({ jsonrpc: '2.0', id: 'review', method: 'bridge.tools.invoke', params: { name: 'role_only', args: {} } })
 return { content: [{ type: 'text', text: JSON.stringify(reply) }], isError: 'error' in reply }
} })
ctx.tools.register({ ...tool('configured_read'), execute: async () => ({ content: [{ type: 'text', text: config.scope === 'role' ? 'ROLE_PRIVATE_DATA' : 'PARENT_PUBLIC_DATA' }] }) })
${recheck.liveMcp ? `for (const scope of ['parent','role']) ctx.resources.register({id: 'mcp/review-' + scope + '-server', kind: 'mcp', name: 'review-' + scope + '-server', description: 'fixture'})` : ''}
${resource && recheck.deferred ? `ctx.tools.register({ ...tool('deferred_resource_bridge'), meta: {...tool('deferred_resource_bridge').meta, deferLoading: true}, execute: async (_args, ctx) => ctx.tools.invoke(${JSON.stringify(resource === 'mcp' ? 'list_mcp_resources' : 'skill_read')}, ${JSON.stringify(resource === 'mcp' ? { server: 'review-role-server' } : { name: 'review-role-skill' })}) })` : ''}
${
  resource
    ? `ctx.tools.register({ ...tool('ptc_resource_bridge'), execute: async (_args, ctx) => {
 const reply = await createBridge(ctx)({ jsonrpc: '2.0', id: 'resource-review', method: 'bridge.tools.invoke', params: { name: ${JSON.stringify(resource === 'mcp' ? 'list_mcp_resources' : 'skill_read')}, args: ${JSON.stringify(resource === 'mcp' ? { server: 'review-role-server' } : { name: 'review-role-skill' })} } })
 return { content: [{type:'text',text:JSON.stringify(reply)}],isError:'error' in reply }
} })`
    : ''
}
${resource ? `ctx.tools.register({ ...tool('resource_bridge'), execute: async (_args, ctx) => ctx.tools.invoke(${JSON.stringify(resource === 'mcp' ? 'list_mcp_resources' : 'skill_read')}, ${JSON.stringify(resource === 'mcp' ? { server: 'review-role-server' } : { name: 'review-role-skill' })}) })` : ''}
${
  recheck.scopedRuntimeSkill
    ? `ctx.skills.register({ name: 'review-role-skill', description: 'configured runtime skill', body: config?.scope === 'role' ? 'ROLE_PRIVATE_SKILL' : 'PARENT_PUBLIC_SKILL' })`
    : resource === 'skill' && !recheck.stableSkills
      ? `ctx.skills.register({ name: 'review-parent-skill', description: 'parent skill', body: 'PARENT_PUBLIC_SKILL' })
ctx.skills.register({ name: 'review-role-skill', description: 'role skill', body: 'ROLE_PRIVATE_SKILL' })`
      : ''
}
`,
      },
      ...(recheck.warmedBridge
        ? [
            {
              exportName: 'sharedBridge',
              rowId: 'ext:fixture/review-bridge',
              body: `ctx.tools.register({ ...tool('warmed_shared_bridge'), meta: { ...tool('warmed_shared_bridge').meta, deferLoading: ${recheck.warmedBridge === 'deferred'} }, execute: async (_args, ctx) => {
${
  recheck.warmedBridge === 'ptc'
    ? `const reply = await createBridge(ctx)({ jsonrpc: '2.0', id: 'warmed-review', method: 'bridge.tools.invoke', params: { name: 'skill_read', args: {name: 'review-role-skill'} } }); return {content: [{type: 'text', text: JSON.stringify(reply)}], isError: 'error' in reply}`
    : `return await ctx.tools.invoke('skill_read', {name: 'review-role-skill'})`
}
} })`,
            },
          ]
        : []),
    ],
    { vendor },
  )
  const privateSkillDirectory = join(raw.snapshot.directory, 'skill-files')
  if (recheck.skillFiles) {
    mkdirSync(privateSkillDirectory)
    writeFileSync(join(privateSkillDirectory, 'secret.txt'), 'ROLE_PRIVATE_SKILL_ATTACHMENT')
    requestCall = recheck.readVia
      ? { name: 'file_bridge', args: {} }
      : { name: 'read', args: { path: join(privateSkillDirectory, 'secret.txt') } }
  }
  const manifestFile = join(raw.snapshot.directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const bundle = (tools: string[], limit = 4) => ({
    profile: { tools, toolPolicy: { allow: tools } },
    presets: {
      role: { name: 'role', extends: 'standard', subagent: { max_depth: limit, max_fan_out: limit } },
    },
    launch: {
      title: { en: 'Backend Reader' },
      description: { en: 'Inspect reviewed evidence' },
      preset: 'role',
    },
  })
  manifest.agnes.bundles = {
    assistant: bundle(['common_read', 'bridge', 'ptc_bridge', 'subagent_spawn'], 1),
    reader: bundle(['common_read', 'bridge', 'ptc_bridge', 'role_only']),
  }
  if (configured) {
    for (const [name, scope] of [
      ['assistant', 'parent'],
      ['reader', 'role'],
    ] as const) {
      const profile = manifest.agnes.bundles[name].profile
      profile.tools.push('configured_read')
      profile.plugins = { 'ext:fixture/review-role': { config: { scope } } }
    }
  }
  if (resource) {
    for (const [name, scope] of [
      ['assistant', 'parent'],
      ['reader', 'role'],
    ] as const) {
      const profile = manifest.agnes.bundles[name].profile
      profile.tools.push('resource_bridge', resource === 'mcp' ? 'list_mcp_resources' : 'skill_read')
      if (requestCall?.name === 'ptc_resource_bridge') profile.tools.push('ptc_resource_bridge')
      if (recheck.deferred) profile.tools.push('deferred_resource_bridge')
      if (recheck.disclose) profile.tools.push('tool_describe', 'tool_search')
      if (recheck.warmedBridge) profile.tools.push('warmed_shared_bridge')
      profile[resource === 'mcp' ? 'mcp' : 'skills'] = [
        `review-${recheck.commonResources ? 'role' : scope}-${resource === 'mcp' ? 'server' : 'skill'}`,
      ]
    }
  }
  if (recheck.skillFiles) {
    manifest.agnes.bundles.reader.profile.skills = []
    for (const name of ['assistant', 'reader'])
      manifest.agnes.bundles[name].profile.tools.push('read', ...(recheck.readVia ? ['file_bridge'] : []))
  }
  if (recheck.emptyTools) {
    const name = recheck.emptyTools === 'parent' ? 'assistant' : 'reader'
    manifest.agnes.bundles[name].profile.toolPolicy.allow = []
  }
  if (recheck.config) {
    for (const name of ['assistant', 'reader']) {
      const profile = manifest.agnes.bundles[name].profile
      profile.tools.push('configured_read')
      const config =
        recheck.config === 'canonical'
          ? name === 'assistant'
            ? { scope: 'parent', nested: { a: 1, b: [2, 3] } }
            : { nested: { b: [2, 3], a: 1 }, scope: 'parent' }
          : recheck.config === 'same'
            ? { scope: 'parent' }
            : name === 'assistant'
              ? undefined
              : {}
      profile.plugins = { 'ext:fixture/review-role': config === undefined ? {} : { config } }
    }
  }
  if (resource === 'skill') manifest.agnes.plugins[0].inject.push('skills')
  if (recheck.liveMcp) manifest.agnes.plugins[0].inject.push('resources')
  const declaration = {
    id: 'review',
    agents: ['assistant', 'reader'].map(ref),
    delegableAgents: [ref('reader')],
  }
  manifest.agnes.application = declaration
  writeFileSync(manifestFile, JSON.stringify(manifest))
  const entry = join(raw.snapshot.directory, 'index.js')
  writeFileSync(
    entry,
    `import { Type } from ${JSON.stringify(import.meta.resolve('@sinclair/typebox'))}\nimport { createBridge } from ${JSON.stringify(import.meta.resolve('@agnes/code'))}\n` +
      readFileSync(entry, 'utf8')
        .replace('"__ROLE_SKILL_FILE__"', JSON.stringify(join(privateSkillDirectory, 'secret.txt')))
        .replace(
          "parameters: { type: 'object', properties: {}, additionalProperties: false }",
          'parameters: Type.Object({}, { additionalProperties: false })',
        )
        .replace(
          "inject: ['hooks', 'eventLog', 'self', 'tools']",
          resource === 'skill'
            ? "inject: ['hooks', 'eventLog', 'self', 'tools', 'skills']"
            : recheck.liveMcp
              ? "inject: ['hooks', 'eventLog', 'self', 'tools', 'resources']"
              : "inject: ['hooks', 'eventLog', 'self', 'tools']",
        ),
  )
  const source = {
    ...raw,
    snapshot: { ...raw.snapshot, treeIntegrity: hashDirectory(raw.snapshot.directory, { exclude: [] }) },
  }
  const requests: RequestBody[] = []
  const skills = createSkillCandidateRegistry({ barrier: { quiesce: async (_id, publish) => publish({}) } })
  if (recheck.stableSkills) {
    const candidates = ['parent', 'role'].map((scope) => {
      const name = `review-${scope}-skill`
      const sourceId = digest(name)
      return {
        resourceId: `skill/user/user-agnes/${sourceId}`,
        name,
        description: name,
        revision: digest({ name, body: scope }),
        capabilityHash: digest({ name }),
        sourceIdentity: { scope: 'user' as const, rootKey: 'user-agnes' as const, sourceId },
        priority: 400,
        body: scope === 'role' ? 'ROLE_PRIVATE_SKILL' : 'PARENT_PUBLIC_SKILL',
        ...(recheck.skillFiles && scope === 'role' ? { directory: privateSkillDirectory } : {}),
      }
    })
    skills.replaceRoot('user-agnes', candidates)
    skills.setControl({
      desired: candidates.map((candidate) => ({ resourceId: candidate.resourceId, state: 'enabled' })),
      trust: candidates.map((candidate) => ({
        resourceId: candidate.resourceId,
        revision: candidate.revision,
        capabilityHash: candidate.capabilityHash,
        state: 'trusted',
      })),
    })
    await skills.activate('recheck-fixture', async () => {})
  }
  const hostOptions: Partial<TestHostOptions> = {
    ...(recheck.skillFiles ? { dataDir: join(scratch(), 'data') } : {}),
    disableSessionTitle: true,
    treeBudgetCredits: 100,
    ...(resource === 'skill'
      ? { skillResources: skills.snapshot(), skillContribution: createSkillCordisService(skills) }
      : {}),
    provider: (profile) =>
      new ScriptedProvider({
        models: profile.provider.routes?.flatMap((r) => r.models ?? []) ?? [],
        scripts: [
          (request) => {
            requests.push(request)
            const results = request.messages.filter((m) => m.role === 'tool_result').length
            const call =
              recheck.disclose && results === 0
                ? { name: 'tool_describe', args: { name: requestCall!.name } }
                : (requestCall ?? { name: 'bridge', args: {} })
            return results > (recheck.disclose ? 1 : 0)
              ? [
                  { type: 'text_delta', delta: 'done' },
                  { type: 'done', reason: 'stop' },
                ]
              : ([
                  { type: 'toolcall_end', call: { ...call, toolUseId: '', ordinal: 0 }, via: 'native' },
                  { type: 'done', reason: 'toolUse' },
                ] as InferenceEvent[])
          },
        ],
      }),
  }
  const fixture = await pluginHost(source, hostOptions)
  if (recheck.skillFiles) fixture.dataDir = hostOptions.dataDir!
  const row = pluginRow('ext:fixture/review-role', 'plugin', false, { vendor })
  await fixture.host.applyRuntimeTarget(
    targetOf([
      ...fixture.host.extensionRows.current(),
      ...(resource === 'skill' || recheck.liveMcp
        ? [
            createPluginRow({
              ...row,
              snapshotDigest: source.snapshot.integrity,
              exportName: 'plugin',
              inject: [...row.inject, resource === 'skill' ? 'skills' : 'resources'],
            }),
          ]
        : [row]),
      ...(recheck.warmedBridge
        ? [pluginRow('ext:fixture/review-bridge', 'sharedBridge', false, { vendor })]
        : []),
    ]),
  )
  const config = createConfigurationService({
    home: fixture.dataDir,
    profile: 'local-dev',
    profileDir: join(fixture.dataDir, 'profiles/local-dev'),
  })
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
  const preview: ApplicationPreview = { ...body, consentDigest: digest(body) }
  const selection = {
    packageId: vendor,
    applicationId: 'review',
    integrity: source.snapshot.integrity,
    declarationDigest: preview.declarationDigest,
    consentDigest: preview.consentDigest,
    bindingDigest: digest({}),
    consentSnapshot: preview,
  }
  const save = async (selected: typeof selection | null = selection) => {
    const state = await config.application!()
    await config.saveApplication!({ revision: state?.revision ?? 0, selection: selected })
  }
  const parent = await fixture.host.createSession({
    key: 'parent',
    cwd: fixture.dataDir,
    agent: ref('assistant'),
  })
  const create = (role = ref('reader'), extra = {}) =>
    parent.d.children.createWithKind!('spawn', {
      parent: parent.key,
      cwd: fixture.dataDir,
      input: 'Inspect',
      resident: true,
      role,
      ...extra,
    })
  const restart = async () => {
    const target = fixture.host.runtimeTargetSnapshot!()
    await fixture.host.close()
    const next = await createTestHost({
      dataDir: fixture.dataDir,
      packageDirs,
      runtimePluginCatalogue: [source],
      extensionLoader: { import: async (file) => await import(pathToFileURL(file).href) },
      ...hostOptions,
    })
    fixture.host = next.host
    await fixture.host.applyRuntimeTarget(target)
  }
  return { fixture, config, selection, save, parent, create, requests, entry, restart }
}

it('review-role: cleared, cross-profile and tampered application inputs cannot mint a role child', async () => {
  const f = await setup()
  try {
    await expect(f.create()).rejects.toThrow('not delegable')
    const other = createConfigurationService({
      home: f.fixture.dataDir,
      profile: 'other',
      profileDir: join(f.fixture.dataDir, 'profiles/other'),
    })
    await other.saveApplication!({ revision: 0, selection: f.selection })
    await expect(f.create()).rejects.toThrow('not delegable')
    await f.save()
    await expect(f.create(ref('assistant'))).rejects.toThrow('not delegable')
    await expect(f.create(ref('unknown'))).rejects.toThrow()
    await f.save({ ...f.selection, applicationId: 'other-app' })
    await expect(f.create()).rejects.toThrow('not delegable')
    const altered = structuredClone(f.selection)
    altered.consentSnapshot.declaration.brand = { name: { en: 'forged' } }
    const { consentDigest: _digest, ...body } = altered.consentSnapshot
    altered.consentDigest = altered.consentSnapshot.consentDigest = digest(body)
    await f.save(altered)
    await expect(f.create()).rejects.toThrow('not delegable')
    await f.save({ ...f.selection, consentDigest: '0'.repeat(64) })
    await expect(f.create()).rejects.toThrow('not delegable')
    await f.save({
      ...f.selection,
      consentSnapshot: {
        ...f.selection.consentSnapshot,
        declaration: { ...f.selection.consentSnapshot.declaration, delegableAgents: [ref('assistant')] },
      },
    })
    await expect(f.create()).rejects.toThrow('not delegable')
    await f.save(null)
    await expect(f.create()).rejects.toThrow('not delegable')
    await f.save()
    const bytes = readFileSync(f.entry)
    writeFileSync(f.entry, `${bytes}\n// changed after adoption\n`)
    await expect(f.create()).rejects.toThrow()
    writeFileSync(f.entry, bytes)
    expect(await f.parent.d.children.list?.()).toEqual([])
  } finally {
    await f.fixture.host.close()
  }
}, 90_000)

it.each(['mcp', 'skill'] as const)(
  'review-role: a shared %s bridge cannot broaden the parent resource selection',
  async (resource) => {
    const requested: string[] = []
    const unbind =
      resource === 'mcp'
        ? ['review-parent-server', 'review-role-server'].map((id) =>
            bindMcpResourceServer(
              id,
              {
                id,
                supportsResources: true,
                listResources: async () => {
                  requested.push(id)
                  return { resources: [{ name: id, uri: 'fixture://' + id }] }
                },
              } as McpConnection,
              { id, transport: 'stdio', cmd: ['fixture'], defer: false },
            ),
          )
        : []
    const f = await setup({ name: 'resource_bridge', args: {} }, false, resource)
    try {
      await f.save()
      await f.parent.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Inspect resource' }],
        actor: f.parent.d.actor,
      })
      await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      const parentRows = await f.parent.scan({ type: 'tool/result', limit: 100 })
      expect(parentRows.some(refused)).toBe(true)
      expect(requested).toEqual([])
      const child = await f.create()
      await child.run('Inspect')
      const rows = await f.parent.d.log.storage.scan(child.key, { type: 'tool/result', limit: 100 })
      expect.soft(JSON.stringify(rows)).not.toContain('ROLE_PRIVATE_SKILL')
      expect.soft(requested).not.toContain('review-role-server')
      expect(rows.some(refused)).toBe(true)
      await child.cancel?.()
    } finally {
      await f.fixture.host.close()
      for (const close of unbind) close()
    }
  },
  90_000,
)

it.each(['bridge', 'ptc_bridge'])(
  'review-role: nested %s cannot access a role-only tool and a valid Host snapshot survives reopen',
  async (name) => {
    const f = await setup({ name, args: {} })
    try {
      await f.save()
      const handle = await f.create()
      await handle.run('Inspect')
      const rows = await f.parent.d.log.storage.scan(handle.key, { type: 'tool/result', limit: 100 })
      expect(JSON.stringify(rows)).not.toContain('"text":"role_only"')
      expect(rows.some(refused)).toBe(true)
      const child = f.fixture.host.kernel.get(handle.key)!
      const before = structuredClone(child.d.roleDelegation)
      await handle.cancel?.()
      const reopened = await f.fixture.host.createSession({ key: handle.key, cwd: f.fixture.dataDir })
      expect(reopened.d.roleDelegation).toMatchObject({ ...before, approvalPolicy: 'never' })
      expect(
        reopened
          .currentTools()
          .list()
          .map((t) => t.name)
          .sort(),
      ).toEqual(['bridge', 'common_read', 'ptc_bridge'])
      await reopened.setYolo(true, reopened.d.actor)
      expect(reopened.yolo).toBe(false)
      expect(reopened.permissionContext.policy).toBe('workspace-write')
      await reopened.close()
    } finally {
      await f.fixture.host.close()
    }
  },
  90_000,
)

it.each([{ permission: 'full-access' }, { name: 'Forged QA' }, { fork: true }, { model: 'gw/m1' }])(
  'review-role: model spawn input %j is rejected before child creation',
  async (extra) => {
    const f = await setup({
      name: 'subagent_spawn',
      args: { task: 'Inspect', role: ref('reader'), ...extra },
    })
    try {
      await f.save()
      await f.parent.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Delegate' }],
        actor: f.parent.d.actor,
      })
      await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      expect(await f.parent.d.children.list?.()).toEqual([])
      const rows = await f.parent.scan({ type: 'tool/result', limit: 50 })
      expect(rows.some(refused)).toBe(true)
    } finally {
      await f.fixture.host.close()
    }
  },
  90_000,
)

it('review-role: a same-name tool with a different composition configuration cannot read beyond the parent', async () => {
  const f = await setup({ name: 'configured_read', args: {} }, true)
  try {
    await f.save()
    await f.parent.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Inspect configured data' }],
      actor: f.parent.d.actor,
    })
    await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    expect(JSON.stringify(await f.parent.scan({ type: 'tool/result', limit: 100 }))).toContain(
      'PARENT_PUBLIC_DATA',
    )
    await expect(f.create()).rejects.toThrow('no tools after authority intersection')
    expect(await f.parent.d.children.list?.()).toEqual([])
    expect((await f.parent.scan({ type: 'x/host/role-tool-intersection', limit: 100 })).at(-1)).toMatchObject(
      {
        data: {
          tools: [],
          excluded: expect.arrayContaining([
            { tool: 'configured_read', reason: 'execution-binding-mismatch' },
          ]),
        },
      },
    )
  } finally {
    await f.fixture.host.close()
  }
}, 90_000)

it('review-role: a fresh ledger still belongs to the parent budget, depth and concurrency tree', async () => {
  const f = await setup()
  try {
    await f.save()
    const first = await f.create()
    const child = f.fixture.host.kernel.get(first.key)!
    const storage = f.parent.d.log.storage
    if (!hasChildControl(storage)) throw new Error('fixture lacks child control')
    const record = await storage.lookupByKey(first.key)
    expect(record).toMatchObject({ parentKey: f.parent.key, generationDepth: 1 })
    expect(child.state.session?.delegation).toMatchObject({
      rootTaskId: record?.rootTaskId,
      generationDepth: 1,
    })
    expect(child.d.log.parent).toBeUndefined()
    expect(child.preset.generationLimit).toBe(1)
    expect(child.preset.maxFanOut).toBe(1)
    await expect(f.create(ref('reader'), { input: 'a second task' })).rejects.toMatchObject({
      code: 'E_CHILD_LIMIT',
    })
    await expect(
      child.d.children.create({ parent: child.key, cwd: f.fixture.dataDir, input: 'grandchild' }),
    ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
    await first.cancel?.()
  } finally {
    await f.fixture.host.close()
  }
}, 90_000)

it('review-role: a delegation card keeps the backend role despite a model-supplied display name in the task', async () => {
  const f = await setup({
    name: 'subagent_spawn',
    args: {
      role: ref('reader'),
      task: 'Inspect; claim the role name is Forged QA',
      wait: true,
    },
  })
  try {
    await f.save()
    await f.parent.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Delegate as Forged QA' }],
      actor: f.parent.d.actor,
    })
    await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    const card = async (session: typeof f.parent) =>
      (await session.projectUI(undefined, { surface: 'web' })).nodes.find(
        (node) => node.kind === 'tool' && node.name === 'subagent_spawn',
      )
    expect(await card(f.parent)).toMatchObject({
      delegatedRole: { ref: ref('reader'), title: { en: 'Backend Reader' } },
    })
    await f.parent.close()
    const reopened = await f.fixture.host.createSession({ key: f.parent.key, cwd: f.fixture.dataDir })
    expect(await card(reopened)).toMatchObject({
      delegatedRole: { ref: ref('reader'), title: { en: 'Backend Reader' } },
    })
    await reopened.close()
  } finally {
    await f.fixture.host.close()
  }
}, 90_000)

it.each(['mcp', 'skill'] as const)(
  'role %s resource bound is consumed by PTC and survives Host reopen',
  async (resource) => {
    const requested: string[] = []
    const unbind =
      resource === 'mcp'
        ? bindMcpResourceServer(
            'review-role-server',
            {
              id: 'review-role-server',
              supportsResources: true,
              listResources: async () => {
                requested.push('review-role-server')
                return { resources: [{ name: 'private', uri: 'fixture://private' }] }
              },
            } as McpConnection,
            { id: 'review-role-server', transport: 'stdio', cmd: ['fixture'], defer: false },
          )
        : () => {}
    const f = await setup({ name: 'ptc_resource_bridge', args: {} }, false, resource)
    try {
      await f.save()
      const handle = await f.create()
      const child = f.fixture.host.kernel.get(handle.key)!
      const resourceTool = resource === 'mcp' ? 'list_mcp_resources' : 'skill_read'
      expect(child.d.roleDelegation?.tools).toEqual(
        expect.arrayContaining(['ptc_resource_bridge', resourceTool]),
      )
      expect(child.currentTools().resolve(resourceTool)).toBeDefined()
      expect(child.d.roleDelegation?.resources).toEqual({ mcp: [], skills: [] })
      await handle.run('Inspect')
      expect(requested).toEqual([])
      const rows = await f.parent.d.log.storage.scan(handle.key, { type: 'tool/result', limit: 100 })
      expect(JSON.stringify(rows)).not.toContain('ROLE_PRIVATE_SKILL')
      expect(JSON.stringify(rows)).not.toContain('fixture://private')
      expect(rows.some((row) => JSON.stringify(row).includes('"isError":true'))).toBe(true)
      await handle.cancel?.()
      await f.parent.close()
      const reopened = await f.fixture.host.createSession({ key: handle.key, cwd: f.fixture.dataDir })
      expect(reopened.d.roleDelegation?.resources).toEqual({ mcp: [], skills: [] })
      const caps = f.fixture.host.sessionCapabilities!(handle.key)
      expect(caps[resource === 'mcp' ? 'mcp' : 'skills'].some((item) => item.enabled)).toBe(false)
      await reopened.close()
    } finally {
      await f.fixture.host.close()
      unbind()
    }
  },
  90_000,
)

it.each(['same', 'canonical', 'absent-empty'] as const)(
  'recheck-role: concrete binding handles %s configuration without widening or losing identical tools',
  async (config) => {
    const f = await setup({ name: 'configured_read', args: {} }, false, undefined, { config })
    try {
      await f.save()
      if (config === 'absent-empty') {
        await expect(f.create()).rejects.toThrow('no tools after authority intersection')
        expect(await f.parent.d.children.list?.()).toEqual([])
        return
      }
      const handle = await f.create()
      const child = f.fixture.host.kernel.get(handle.key)!
      expect(child.d.roleDelegation?.tools.includes('configured_read')).toBe(true)
      expect(!!child.currentTools().resolve('configured_read')).toBe(true)
      await handle.run('Inspect')
      const rows = await f.parent.d.log.storage.scan(handle.key, { type: 'tool/result', limit: 100 })
      expect(JSON.stringify(rows).includes('PARENT_PUBLIC_DATA')).toBe(true)
      expect(JSON.stringify(rows)).not.toContain('ROLE_PRIVATE_DATA')
      await handle.cancel?.()
    } finally {
      await f.fixture.host.close()
    }
  },
  90_000,
)

const resourceRechecks = (['mcp', 'skill'] as const).flatMap((resource) =>
  (['direct', 'nested', 'ptc', 'deferred'] as const).flatMap((path) =>
    [false, true].map((common) => ({ resource, path, common })),
  ),
)

it('recheck-role: a warmed role composition cannot put its runtime Skill into the parent resource ceiling', async () => {
  const f = await setup({ name: 'skill_read', args: { name: 'review-role-skill' } }, true, 'skill', {
    commonResources: true,
    disclose: true,
    scopedRuntimeSkill: true,
  })
  try {
    await f.save()
    await f.parent.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Read skill' }],
      actor: f.parent.d.actor,
    })
    await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    const parentRows = JSON.stringify(await f.parent.scan({ type: 'tool/result', limit: 100 }))
    expect(parentRows).toContain('PARENT_PUBLIC_SKILL')
    expect(parentRows).not.toContain('ROLE_PRIVATE_SKILL')
    // A normal first delegation mounts both the role and the narrowed child composition.
    const first = await f.create()
    await first.run('Inspect')
    const firstRows = await f.parent.d.log.storage.scan(first.key, { type: 'tool/result', limit: 100 })
    expect(JSON.stringify(firstRows)).not.toContain('ROLE_PRIVATE_SKILL')
    expect(firstRows.some(refused)).toBe(true)
    await first.cancel?.()
    const control = await f.fixture.host.createSession({
      key: 'parent-control',
      cwd: f.fixture.dataDir,
      agent: ref('assistant'),
    })
    await control.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Read skill after warming' }],
      actor: control.d.actor,
    })
    await control.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    const controlRows = JSON.stringify(await control.scan({ type: 'tool/result', limit: 100 }))
    expect(controlRows).toContain('PARENT_PUBLIC_SKILL')
    expect(controlRows).not.toContain('ROLE_PRIVATE_SKILL')
    await control.close()
    const second = await f.create(ref('reader'), { input: 'Read skill after warming' })
    const child = f.fixture.host.kernel.get(second.key)!
    expect(child.d.roleDelegation?.tools).toContain('skill_read')
    expect(child.d.roleDelegation?.tools).not.toContain('configured_read')
    await second.run('Read skill after warming')
    const rows = await f.parent.d.log.storage.scan(second.key, { type: 'tool/result', limit: 100 })
    expect(JSON.stringify(rows)).not.toContain('ROLE_PRIVATE_SKILL')
    expect(rows.some(refused)).toBe(true)
    await second.cancel?.()
  } finally {
    await f.fixture.host.close()
  }
}, 90_000)

it.each(resourceRechecks)(
  'recheck-role: $resource $path common=$common keeps the resource ceiling after actual reopen',
  async ({ resource, path, common }) => {
    const requested: string[] = []
    const unbind =
      resource === 'mcp'
        ? bindMcpResourceServer(
            'review-role-server',
            {
              id: 'review-role-server',
              supportsResources: true,
              listResources: async () => {
                requested.push('review-role-server')
                return { resources: [{ name: 'private', uri: 'fixture://private' }] }
              },
            } as McpConnection,
            { id: 'review-role-server', transport: 'stdio', cmd: ['fixture'], defer: true },
          )
        : () => {}
    const name =
      path === 'direct'
        ? resource === 'mcp'
          ? 'list_mcp_resources'
          : 'skill_read'
        : path === 'nested'
          ? 'resource_bridge'
          : path === 'ptc'
            ? 'ptc_resource_bridge'
            : 'deferred_resource_bridge'
    const args =
      path !== 'direct'
        ? {}
        : resource === 'mcp'
          ? { server: 'review-role-server' }
          : { name: 'review-role-skill' }
    const f = await setup({ name, args }, false, resource, {
      commonResources: common,
      deferred: path === 'deferred',
      disclose: true,
      liveMcp: resource === 'mcp',
      stableSkills: resource === 'skill',
    })
    try {
      await f.save()
      const kind = resource === 'mcp' ? 'mcp' : 'skills'
      const parentIds = f.fixture.host.sessionCapabilities!(f.parent.key)
        [kind].filter((item) => item.enabled)
        .map((item) => item.id)
      const handle = await f.create()
      const child = f.fixture.host.kernel.get(handle.key)!
      const before = structuredClone(child.d.roleDelegation)
      expect(parentIds.length).toBeGreaterThan(0)
      expect(before?.resources?.[kind]).toEqual(common ? parentIds : [])
      expect(child.currentTools().resolve(name)).toBeDefined()
      if (path === 'deferred') expect(child.currentTools().resolve(name)?.meta.deferLoading).toBe(true)
      // Close before any turn and resume without the parent or a caller-supplied snapshot.
      await handle.cancel?.()
      await f.parent.close()
      if (path === 'ptc' || path === 'deferred') await f.restart()
      const reopened = await f.fixture.host.createSession({ key: handle.key, cwd: f.fixture.dataDir })
      expect(reopened.d.roleDelegation).toEqual(before)
      expect(
        f.fixture.host.sessionCapabilities!(handle.key)
          [kind].filter((item) => item.enabled)
          .map((item) => item.id),
      ).toEqual(common ? parentIds : [])
      await reopened.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Inspect resource' }],
        actor: reopened.d.actor,
      })
      await reopened.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      const rows = await reopened.scan({ type: 'tool/result', limit: 100 })
      const serialized = JSON.stringify(rows)
      if (common) {
        expect(rows.some(refused), JSON.stringify({ before, parentIds, rows })).toBe(false)
        expect(serialized).toContain(resource === 'mcp' ? 'fixture://private' : 'ROLE_PRIVATE_SKILL')
        if (resource === 'mcp') expect(requested).toEqual(['review-role-server'])
      } else {
        expect(rows.some(refused)).toBe(true)
        expect(serialized).not.toContain('ROLE_PRIVATE_SKILL')
        expect(serialized).not.toContain('fixture://private')
        expect(requested).toEqual([])
      }
      await reopened.close()
    } finally {
      await f.fixture.host.close()
      unbind()
    }
  },
  90_000,
)

it.each(['ptc', 'deferred'] as const)(
  'second-recheck-role: a warmed runtime Skill stays refused through an eligible %s bridge',
  async (path) => {
    const f = await setup({ name: 'warmed_shared_bridge', args: {} }, true, 'skill', {
      commonResources: true,
      disclose: true,
      scopedRuntimeSkill: true,
      warmedBridge: path,
    })
    try {
      await f.save()
      await f.parent.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Read the Skill through the bridge' }],
        actor: f.parent.d.actor,
      })
      await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      const parentRows = await f.parent.scan({ type: 'tool/result', limit: 100 })
      expect(JSON.stringify(parentRows)).toContain('PARENT_PUBLIC_SKILL')
      expect(JSON.stringify(parentRows)).not.toContain('ROLE_PRIVATE_SKILL')
      expect(parentRows.some(refused)).toBe(false)
      for (const input of ['Inspect', 'Inspect after warming']) {
        const handle = await f.create(ref('reader'), { input })
        const child = f.fixture.host.kernel.get(handle.key)!
        // The bridge has a separate, identical Host binding in both compositions. Refusal
        // must come from the resource ceiling, rather than excluding a differently configured tool.
        expect(child.d.roleDelegation?.tools).toContain('warmed_shared_bridge')
        expect(child.d.roleDelegation?.tools).toContain('skill_read')
        expect(child.d.roleDelegation?.tools).not.toContain('configured_read')
        expect(child.d.roleDelegation?.resources?.skills).toEqual([])
        expect(child.currentTools().resolve('warmed_shared_bridge')?.meta.deferLoading).toBe(
          path === 'deferred',
        )
        await handle.run(input)
        const rows = await f.parent.d.log.storage.scan(handle.key, { type: 'tool/result', limit: 100 })
        const disclosure = rows.find((row) => row.origin === 'tool:tool_describe')
        expect(disclosure).toBeDefined()
        expect(refused(disclosure!)).toBe(false)
        expect(JSON.stringify(disclosure)).toContain('warmed_shared_bridge')
        expect(rows.some((row) => row.origin === 'tool:warmed_shared_bridge')).toBe(true)
        expect(rows.some(refused)).toBe(true)
        expect(JSON.stringify(rows)).not.toContain('ROLE_PRIVATE_SKILL')
        await handle.cancel?.()
      }
    } finally {
      await f.fixture.host.close()
    }
  },
  90_000,
)

it.each([
  { reopen: false },
  { reopen: true },
  { reopen: false, via: 'ptc' as const },
  { reopen: false, via: 'deferred' as const },
])(
  'role: ordinary read cannot escape captured Skill and filesystem scopes through readRoots %j',
  async ({ reopen, via }) => {
    const f = await setup(undefined, false, 'skill', {
      stableSkills: true,
      skillFiles: true,
      ...(via ? { readVia: via } : {}),
      ...(via === 'deferred' ? { disclose: true } : {}),
    })
    try {
      await f.save()
      await f.parent.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Inspect file' }],
        actor: f.parent.d.actor,
      })
      await f.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      const parentRows = await f.parent.scan({ type: 'tool/result', limit: 100 })
      expect(JSON.stringify(parentRows)).not.toContain('ROLE_PRIVATE_SKILL_ATTACHMENT')
      const control = await f.fixture.host.createSession({
        key: 'reader-control',
        cwd: f.fixture.dataDir,
        agent: ref('reader'),
      })
      await control.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Inspect file' }],
        actor: control.d.actor,
      })
      await control.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      expect(JSON.stringify(await control.scan({ type: 'tool/result', limit: 100 }))).toContain(
        'ROLE_PRIVATE_SKILL_ATTACHMENT',
      )
      await control.close()
      const handle = await f.create()
      const child = f.fixture.host.kernel.get(handle.key)!
      expect(child.currentTools().resolve('read')).toBeDefined()
      if (via) expect(child.currentTools().resolve('file_bridge')).toBeDefined()
      expect(child.roleAuthority!.resources.skills.ids).toEqual([
        `skill/user/user-agnes/${digest('review-parent-skill')}`,
      ])
      if (reopen) await f.restart()
      const active = reopen
        ? await f.fixture.host.createSession({ key: handle.key, cwd: f.fixture.dataDir })
        : child
      expect(active.currentTools().resolve('read')).toBeDefined()
      if (reopen) {
        await active.setYolo(true, active.d.actor)
        expect(active.yolo).toBe(false)
        await active.enqueue('next-turn', {
          content: [{ type: 'text', text: 'Inspect file after reopen' }],
          actor: active.d.actor,
        })
        await active.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      } else await handle.run('Inspect')
      const rows = await active.scan({ type: 'tool/result', limit: 100 })
      expect(JSON.stringify(rows)).not.toContain('ROLE_PRIVATE_SKILL_ATTACHMENT')
      expect(rows.some(refused)).toBe(true)
      if (reopen) await active.close()
      else await handle.cancel?.()
    } finally {
      await f.fixture.host.close()
    }
  },
  90_000,
)

it.each(['parent', 'role'] as const)(
  'role: a literal empty %s tool ceiling refuses spawn instead of becoming default selection',
  async (side) => {
    const f = await setup({ name: 'common_read', args: {} }, false, undefined, { emptyTools: side })
    try {
      await f.save()
      await expect(f.create()).rejects.toThrow('no tools after authority intersection')
      expect(await f.parent.d.children.list?.()).toEqual([])
      expect(
        (await f.parent.scan({ type: 'x/host/role-tool-intersection', limit: 100 })).at(-1),
      ).toMatchObject({ origin: 'system', trust: 'trusted', data: { tools: [] } })
    } finally {
      await f.fixture.host.close()
    }
  },
  90_000,
)

it('role: same-name registrations cannot alias a different package, version or execution binding', async () => {
  const f = await setup({ name: 'common_read', args: {} })
  try {
    const tool = f.parent.currentTools().resolve('common_read')!
    const identity = roleToolBindingIdentity(f.fixture.host, tool)
    expect(identity).toBeTruthy()
    for (const other of [
      { ...tool, packageIdentity: '@fixture/another-package' },
      { ...tool, packageVersion: '999.0.0' },
      { ...tool, executionBinding: { ...tool.executionBinding!, exportName: 'anotherExport' } },
      { ...tool, executionBinding: { ...tool.executionBinding!, snapshotId: 'different-snapshot' } },
      { ...tool, executionBinding: { ...tool.executionBinding!, rowId: 'ext:unknown' } },
      { ...tool, executionBinding: { ...tool.executionBinding!, configDigest: '0'.repeat(64) } },
      { ...tool, executionBinding: undefined },
    ])
      expect(roleToolBindingIdentity(f.fixture.host, other)).not.toBe(identity)
    expect(
      roleToolBindingIdentity(f.fixture.host, { ...tool, executionBinding: { ...tool.executionBinding! } }),
    ).toBe(identity)
  } finally {
    await f.fixture.host.close()
  }
}, 90_000)
