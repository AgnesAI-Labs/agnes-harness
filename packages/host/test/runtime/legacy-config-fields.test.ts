import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { convertLegacyConfiguration } from '../../src/runtime/config/effective-profile.js'
import {
  LEGACY_MANAGED_PATHS,
  LEGACY_PRESET_PATHS,
  LEGACY_PROFILE_PATHS,
} from '../../src/runtime/config/legacy-field-paths.js'
import {
  classifyLegacyField,
  legacyPaths,
  MAX_STEPS_FEATURE,
} from '../../src/runtime/config/legacy-fields.js'

const schema = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../../packages/protocol/schema/${name}`, import.meta.url)),
      'utf8',
    ),
  )

const schemas = {
  profile: schema('profile.json'),
  preset: schema('preset.json'),
  model: schema('model.json'),
} as Record<string, unknown>

function pointer(root: unknown, path: string): unknown {
  let current = root as Record<string, unknown> | undefined
  for (const part of path.split('/').filter(Boolean)) {
    if (!current || typeof current !== 'object') return undefined
    current = current[part.replaceAll('~1', '/').replaceAll('~0', '~')] as Record<string, unknown>
  }
  return current
}

function resolve(node: unknown, root: unknown, depth: number): unknown {
  if (!node || typeof node !== 'object' || depth > 8) return node
  const ref = (node as { $ref?: string }).$ref
  if (!ref) return node
  if (!ref.startsWith('#/')) {
    const [file, hash] = ref.split('#')
    const other = schemas[file?.replace('.json', '') ?? '']
    if (!other) return { $external: ref }
    return resolve(hash ? pointer(other, hash) : other, other, depth + 1)
  }
  return resolve(pointer(root, ref.slice(1)), root, depth + 1)
}

function leaves(node: unknown, path: string, root: unknown, out: Set<string>, depth: number): void {
  if (depth > 14) return
  const resolved = resolve(node, root, 0) as {
    $external?: string
    oneOf?: unknown[]
    anyOf?: unknown[]
    properties?: Record<string, unknown>
    additionalProperties?: unknown
    type?: string
    items?: unknown
  }
  if (!resolved || typeof resolved !== 'object') return
  if (resolved.$external) {
    out.add(path)
    return
  }
  const branches = resolved.oneOf || resolved.anyOf
  if (branches && !resolved.properties) {
    const before = out.size
    for (const branch of branches) leaves(branch, path, root, out, depth + 1)
    if (out.size === before) out.add(path)
    return
  }
  if (resolved.properties) {
    for (const [key, value] of Object.entries(resolved.properties))
      leaves(value, `${path}/${key}`, root, out, depth + 1)
    if (resolved.additionalProperties && resolved.additionalProperties !== false) out.add(`${path}/*`)
    return
  }
  if (resolved.type === 'array' && resolved.items) {
    const items = resolve(resolved.items, root, 0) as {
      properties?: unknown
      oneOf?: unknown
      anyOf?: unknown
    }
    if (items && (items.properties || items.oneOf || items.anyOf))
      leaves(resolved.items, `${path}[]`, root, out, depth + 1)
    else out.add(`${path}[]`)
    return
  }
  if (path) out.add(path)
}

function collect(rootName: string, defName: string): string[] {
  const root = schemas[rootName] as { $defs: Record<string, unknown> }
  const out = new Set<string>()
  leaves(root.$defs[defName], '', root, out, 0)
  return [...out].sort()
}

const presetOf = (document: Record<string, unknown>) =>
  convertLegacyConfiguration({
    presets: [{ layer: 'user', document }],
    presetId: String(document.name),
  })

it('classifies every legacy profile, managed, and preset field', () => {
  const profile = collect('profile', 'RuntimeProfileManifest')
  const managed = collect('profile', 'ManagedPolicy')
  const preset = collect('preset', 'PresetDoc')
  expect(profile).toEqual([...LEGACY_PROFILE_PATHS])
  expect(managed.filter((path) => !profile.includes(path))).toEqual(
    [...LEGACY_MANAGED_PATHS].filter((path) => !profile.includes(path)),
  )
  expect(preset).toEqual([...LEGACY_PRESET_PATHS])
  for (const path of legacyPaths('profile')) expect(classifyLegacyField('profile', path).path).toBe(path)
  for (const path of legacyPaths('managed')) expect(classifyLegacyField('managed', path).path).toBe(path)
  for (const path of legacyPaths('preset')) expect(classifyLegacyField('preset', path).path).toBe(path)
  expect(() => classifyLegacyField('preset', '/not/a-field')).toThrow(/unclassified legacy field/)
})

it('keeps max_steps as a primary-decision budget and fills only missing defaults', () => {
  const result = presetOf({
    name: 'sample',
    budget: { max_steps: 7 },
    model: { route: { primary: { route: 'anthropic', model: 'claude' } } },
    subagent: { isolation: 'worktree' },
  })
  expect(result.status).toBe('accepted')
  expect(result.publishable).toBe(true)
  expect(result.features).toEqual([MAX_STEPS_FEATURE])
  expect(result.sessionParameters).toMatchObject({
    budget: { max_steps: 7, preflight: 'estimate' },
    model: { route: { primary: { route: 'anthropic', model: 'claude' } } },
    subagent: { isolation: 'worktree', max_depth: 1, max_fan_out: 4 },
    disclosure: 'standard',
  })
  expect(result.sessionParameters).not.toHaveProperty('tools.core')
  expect(result.sessionParameters).not.toHaveProperty('checkpoint')
  const steps = result.rows.find((row) => row.path === '/budget/max_steps')
  expect(steps).toMatchObject({
    present: true,
    source: 'document',
    value: 7,
    unit: 'primary-decision-steps',
    placed: true,
  })
  expect(result.rows.filter((row) => row.path === '/budget/max_steps')).toHaveLength(1)
  expect(result.rows.filter((row) => row.kind === 'preset')).toHaveLength(LEGACY_PRESET_PATHS.length)
  const fan = result.rows.find((row) => row.path === '/subagent/max_fan_out')
  expect(fan).toMatchObject({ source: 'specified-default', value: 4 })
})

it('reads a bare string model route as that slot and keeps a separate model pin', () => {
  const routed = presetOf({
    name: 'sample',
    model: { route: { primary: 'anthropic' }, id: { primary: 'claude' } },
  })
  expect(routed.status).toBe('accepted')
  expect(routed.sessionParameters).toMatchObject({
    model: { route: { primary: { route: 'anthropic', model: 'claude' } } },
  })
  expect(routed.sessionParameters).not.toHaveProperty('model.id')
  expect(routed.rows.find((row) => row.path === '/model/route/primary/route')).toMatchObject({
    present: true,
    source: 'document',
    value: 'anthropic',
  })
  expect(routed.rows.find((row) => row.path === '/model/route/primary/model')).toMatchObject({
    present: true,
    source: 'document',
    value: 'claude',
  })
  const routeOnly = presetOf({ name: 'sample', model: { route: { primary: 'anthropic' } } })
  expect(routeOnly.rows.find((row) => row.path === '/model/route/primary/route')).toMatchObject({
    present: true,
    source: 'document',
    value: 'anthropic',
  })
  expect(routeOnly.rows.find((row) => row.path === '/model/route/primary/model')).toMatchObject({
    present: false,
    source: 'absent',
  })
  expect(routeOnly.sessionParameters).toBeNull()
  expect(routeOnly.status).toBe('refused')
  expect(routeOnly.diagnostics.some((item) => item.code === 'schema_invalid')).toBe(true)
})

it('defaults missing step ceilings to null and tool output to 32768 bytes', () => {
  const result = presetOf({ name: 'bare' })
  expect(result.status).toBe('accepted')
  expect(result.sessionParameters).toMatchObject({
    budget: { max_steps: null },
    tools: { output_max_bytes: 32768 },
  })
  expect(result.rows.find((row) => row.path === '/budget/max_steps')).toMatchObject({
    source: 'specified-default',
    value: null,
    unit: 'primary-decision-steps',
  })
  expect(result.rows.find((row) => row.path === '/tools/output_max_bytes')).toMatchObject({
    source: 'specified-default',
    value: 32768,
    unit: 'bytes',
  })
  expect(result.features).not.toContain(MAX_STEPS_FEATURE)
})

it('inherits a parent isolation and does not replace it with the bare default', () => {
  const result = convertLegacyConfiguration({
    presets: [
      { layer: 'user', document: { name: 'base', subagent: { isolation: 'worktree', max_depth: 3 } } },
      { layer: 'user', document: { name: 'child', extends: 'base', budget: { max_steps: 7 } } },
    ],
    presetId: 'child',
  })
  expect(result.status).toBe('held')
  expect(result.publishable).toBe(false)
  expect(result.sessionParameters).toMatchObject({
    budget: { max_steps: 7 },
    subagent: { isolation: 'worktree', max_depth: 3, max_fan_out: 4 },
  })
  expect(result.rows.find((row) => row.path === '/subagent/isolation')).toMatchObject({
    source: 'parent',
    value: 'worktree',
  })
  expect(
    result.diagnostics.some((item) => item.code === 'manifest_digest_required' && item.path === '/extends'),
  ).toBe(true)
})

it('reports an unknown field with a stable pointer and leaves the input unchanged', () => {
  const document = { name: 'sample', budget: { max_steps: 4, mystery: true } }
  const snapshot = structuredClone(document)
  const result = presetOf(document)
  expect(document).toEqual(snapshot)
  expect(result.status).toBe('refused')
  expect(result.sessionParameters).toBeNull()
  expect(result.providerConfig).toBeNull()
  expect(result.diagnostics.filter((item) => item.code === 'unknown_field')).toEqual([
    { code: 'unknown_field', path: '/budget/mystery', message: 'unknown field /budget/mystery' },
  ])
})

it('refuses secret material and keeps it out of the result', () => {
  const secret = 'sk-sample'
  const result = presetOf({
    name: 'sample',
    mcp: { servers: [{ id: 'tools', transport: 'stdio', env: { TOKEN: secret } }] },
  })
  expect(result.status).toBe('refused')
  expect(result.sessionParameters).toBeNull()
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(
    result.diagnostics.some((item) => item.code === 'secret_material' && item.path === '/mcp/servers[]/env'),
  ).toBe(true)
})

it('keeps a secret reference and drops the backoff alias when the values agree', () => {
  const result = presetOf({
    name: 'sample',
    model: { retry: { backoff_ms: 10, base_delay_ms: 10 } },
    mcp: { servers: [{ id: 'tools', transport: 'stdio', env: { TOKEN: 'secret://store/token' } }] },
  })
  expect(result.status).toBe('accepted')
  expect(result.sessionParameters).toMatchObject({
    model: { retry: { base_delay_ms: 10 } },
    mcp: { servers: [{ env: { TOKEN: 'secret://store/token' } }] },
  })
  expect(result.sessionParameters).not.toMatchObject({ model: { retry: { backoff_ms: 10 } } })
  expect(result.rows.find((row) => row.path === '/model/retry/backoff_ms')).toMatchObject({
    present: true,
    value: 10,
  })
})

it('refuses unequal retry aliases', () => {
  const result = presetOf({ name: 'sample', model: { retry: { backoff_ms: 10, base_delay_ms: 20 } } })
  expect(result.status).toBe('refused')
  expect(result.sessionParameters).toBeNull()
  expect(
    result.diagnostics.some(
      (item) => item.code === 'retry_conflict' && item.path === '/model/retry/backoff_ms',
    ),
  ).toBe(true)
})

it('maps recovery park to human and approval ask to require_approval', () => {
  const result = presetOf({
    name: 'sample',
    recovery: { unknown_child: 'park' },
    approval: { command_policy: [{ tool: 'bash', argv: 'rm', action: 'ask' }] },
  })
  expect(result.status).toBe('accepted')
  expect(result.sessionParameters).toMatchObject({
    recovery: { unknown_child: 'human' },
    approval: { command_policy: [{ tool: 'bash', argv: 'rm', action: 'require_approval' }] },
  })
  expect(result.rows.find((row) => row.path === '/recovery/unknown_child')?.notes).toContain(
    'park is reported as human',
  )
  expect(result.rows.find((row) => row.path === '/approval/command_policy[]/action')).toMatchObject({
    disposition: 'behavior-correction',
    value: ['require_approval'],
  })
})

it('preserves model.max_tokens without publishing it as a session field', () => {
  const result = presetOf({ name: 'sample', model: { max_tokens: 100 } })
  expect(result.status).toBe('held')
  expect(result.publishable).toBe(false)
  expect(result.sessionParameters).not.toHaveProperty('model.max_tokens')
  expect(result.sessionBlocked).toEqual([
    { path: '/model/max_tokens', value: 100, reason: 'target_schema_missing' },
  ])
  expect(result.rows.find((row) => row.path === '/model/max_tokens')).toMatchObject({
    present: true,
    value: 100,
    placed: false,
  })
})

it('refuses removal of a protected core operation name', () => {
  const result = presetOf({ name: 'sample', operations: { remove: ['Inbox'] } })
  expect(result.status).toBe('refused')
  expect(result.sessionParameters).toBeNull()
  expect(result.diagnostics.some((item) => item.code === 'schema_invalid')).toBe(true)
})

it('reads a YAML preset without changing object key order in the digest', () => {
  const first = presetOf({ name: 'sample', disclosure: 'code', budget: { max_steps: 7, preflight: 'count' } })
  const second = convertLegacyConfiguration({
    presets: [
      {
        layer: 'user',
        document: 'budget:\n  preflight: count\n  max_steps: 7\ndisclosure: code\nname: sample\n',
      },
    ],
    presetId: 'sample',
  })
  expect(first.status).toBe('accepted')
  expect(second.status).toBe('accepted')
  expect(second.sessionDigest).toBe(first.sessionDigest)
  expect(second.providerDigest).toBe(first.providerDigest)
})
