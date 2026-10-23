import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { ApprovalAnswer, ApprovalRequest } from '@agnes/core'
import type { ChildControlStore } from '@agnes/extension-api'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { hashDirectory } from '@agnes/package-manager'
import type { JsonValue } from '@agnes/protocol'
import { jcs } from '@agnes/protocol'
import {
  pluginHost,
  pluginRow,
  pluginSourceWith,
  scratch,
  targetOf,
} from '../assemble/plugin-extension-fixture.js'

const vendor = '@fixture/escalation'
const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
export const roleHuman = { id: 'reviewer', org: 'test', role: 'human', deptPath: [], attrs: {} }

export async function setupRoleEscalation(
  answer: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>,
  review: {
    nested?: boolean
    calls?: (key: string, step: number) => Array<{ name: string; args: Record<string, JsonValue> }>
    hookBody?: string
    tools?: string[]
    commandAction?: 'allow' | 'deny' | 'require_approval'
    home?: string
  } = {},
) {
  const raw = pluginSourceWith(
    [{ exportName: 'plugin', rowId: 'ext:fixture/escalation', body: review.hookBody ?? '' }],
    {
      vendor,
    },
  )
  const file = join(raw.snapshot.directory, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const refs = Array.from({ length: 12 }, (_, index) => `${vendor}#role${index}`) as [string, ...string[]]
  const bundle = (parent: boolean) => ({
    profile: {
      tools: ['write', ...(review.tools ?? []), ...(parent || review.nested ? ['subagent_spawn'] : [])],
      toolPolicy: {
        allow: ['write', ...(review.tools ?? []), ...(parent || review.nested ? ['subagent_spawn'] : [])],
      },
    },
    presets: {
      role: {
        name: 'role',
        extends: 'standard',
        subagent: { max_depth: 2, max_fan_out: 4, isolation: 'shared' },
        approval: {
          command_policy: [
            {
              tool: 'write',
              argv: sep === '\\' ? String.raw`^[A-Za-z]:[\\/].*$` : '^/.*$',
              action: review.commandAction ?? 'allow',
            },
          ],
        },
      },
    },
    launch: {
      title: { en: parent ? 'Coordinator' : 'Requirements' },
      description: { en: 'Write requirements' },
      preset: 'role',
    },
  })
  manifest.agnes.bundles = {
    coordinator: bundle(true),
    ...Object.fromEntries(refs.map((_, i) => [`role${i}`, bundle(false)])),
  }
  const declaration = { id: 'escalation', agents: [`${vendor}#coordinator`, ...refs], delegableAgents: refs }
  manifest.agnes.application = declaration
  writeFileSync(file, JSON.stringify(manifest))
  const source = {
    ...raw,
    snapshot: { ...raw.snapshot, treeIntegrity: hashDirectory(raw.snapshot.directory, { exclude: [] }) },
  }
  const steps = new Map<string, number>()
  // Separate ordinary role work from installation configuration unless a crash fixture pins both.
  const workspaceRoot = review.home ?? scratch()
  const fixture = await pluginHost(source, {
    workspaceRoot,
    ...(review.home ? { dataDir: review.home } : {}),
    seams: {
      approval: {
        ask: (request, options) => answer(request, options?.signal ?? new AbortController().signal),
      },
    },
    treeBudgetCredits: 100,
    disableSessionTitle: true,
    provider: (profile) =>
      new ScriptedProvider({
        models: profile.provider.routes?.flatMap((r) => r.models ?? []) ?? [],
        scripts: [
          (request) => {
            const step = steps.get(request.sessionKey) ?? 0
            steps.set(request.sessionKey, step + 1)
            if (review.calls) {
              const calls = review.calls(request.sessionKey, step)
              return [
                ...calls.map((call, ordinal) => ({
                  type: 'toolcall_end' as const,
                  via: 'native' as const,
                  call: { toolUseId: '', ordinal, ...call },
                })),
                { type: 'done' as const, reason: calls.length ? ('toolUse' as const) : ('stop' as const) },
              ]
            }
            if (step)
              return [
                { type: 'text_delta', delta: 'Done' },
                { type: 'done', reason: 'stop' },
              ]
            return [
              {
                type: 'toolcall_end',
                via: 'native',
                call: {
                  toolUseId: '',
                  ordinal: 0,
                  ...(request.sessionKey === 'parent'
                    ? {
                        name: 'subagent_spawn',
                        args: { role: refs[0]!, task: 'Produce requirements', wait: true },
                      }
                    : {
                        name: 'write',
                        args: { path: `requirements-${steps.size - 1}.md`, content: 'Child requirements' },
                      }),
                },
              },
              { type: 'done', reason: 'toolUse' },
            ]
          },
        ],
      }),
  })
  const dataDir = review.home ?? fixture.dataDir
  await fixture.host.applyRuntimeTarget(
    targetOf([pluginRow('ext:fixture/escalation', 'plugin', false, { vendor })]),
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
    home: dataDir,
    profile: 'local-dev',
    profileDir: join(dataDir, 'profiles/local-dev'),
  })
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
  const parent = await fixture.host.createSession({
    key: 'parent',
    cwd: workspaceRoot,
    agent: `${vendor}#coordinator`,
  })
  return {
    ...fixture,
    dataDir,
    workspaceRoot,
    parent: parent as typeof parent & { d: { log: { storage: ChildControlStore } } },
    refs,
    source,
    target: targetOf([pluginRow('ext:fixture/escalation', 'plugin', false, { vendor })]),
  }
}
