import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXCLUDE_DIRS, isTestFile, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
type Rule = { id: string; pattern: RegExp }
const migrationRules: Rule[] = [
  {
    id: 'legacy_activation_protocol',
    pattern: /(['"])activation\.(?:stage|health|commit|status|restore|finalize|discard)\1/g,
  },
  { id: 'turn_revision', pattern: /\bturnRevision\b/g },
  { id: 'turn_revision_error', pattern: /\bE_TURN_REVISION_MISMATCH\b/g },
  { id: 'selection_for', pattern: /\bselectionFor\b/g },
  { id: 'turn_revision_reply', pattern: /\bturnRevisionReply\b/g },
  { id: 'plugin_assembly_file', pattern: /\bAGNES_PLUGIN_ASSEMBLY_FILE\b/g },
  { id: 'testkit_mount_with', pattern: /\bmountWith\b/g },
  {
    id: 'legacy_resource_revision_read',
    pattern: /\b(?:readResources|resourceSnapshots|readResourceSnapshot)\b/g,
  },
  {
    id: 'legacy_tree_store',
    pattern: /\b(?:PluginTreeStore|TreeReportStore|TreeSnapshotStore)\b/g,
  },
  { id: 'legacy_tree_frame', pattern: /(['"])tree\.(?:stale|converged)\1/g },
  { id: 'c2_tree_snapshot', pattern: /\bTreeSnapshot\b/g },
  { id: 'c2_runtime_target', pattern: /\bRuntimeTarget\b/g },
  { id: 'c2_runtime_stale_frame', pattern: /(['"])runtime\.stale\1/g },
  {
    id: 'c2_runtime_state',
    pattern: /\b(?:ResourceGenerationCell|CandidateRuntime|RuntimeStateCoordinator)\b/g,
  },
] as const

const sessionEnvironmentRules: Rule[] = [
  {
    id: 'legacy_session_worker_environment',
    pattern: /\b(?:AGNES_SESSION_KEY|AGNES_CWD|AGNES_PRESET|AGNES_RESUME)\b/g,
  },
]

function productionSourceFiles(): string[] {
  const packageRoot = join(root, 'packages')
  return readdirSync(packageRoot)
    .flatMap((entry) =>
      listSourceFiles(join(packageRoot, entry, 'src'), {
        excludeDirs: [...DEFAULT_EXCLUDE_DIRS, 'test', 'tests', 'fixtures'],
      }),
    )
    .filter((file) => !isTestFile(file))
}

function runtimeContractFiles(): string[] {
  return [
    ...productionSourceFiles(),
    ...listSourceFiles(join(root, 'packages/cli/launch'), {
      excludeDirs: [...DEFAULT_EXCLUDE_DIRS, 'test', 'tests', 'fixtures'],
    }).filter((file) => !isTestFile(file)),
    ...listSourceFiles(join(root, 'packages/protocol/gen'), { excludeDirs: DEFAULT_EXCLUDE_DIRS }),
    ...readdirSync(join(root, 'packages/protocol/schema'), { withFileTypes: true }).flatMap((entry) =>
      entry.isFile() && entry.name.endsWith('.json')
        ? [join(root, 'packages/protocol/schema', entry.name)]
        : [],
    ),
  ]
}

function scanFiles(rule: Rule, files: string[]): Record<string, number> {
  const hits: Record<string, number> = {}
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const count = Array.from(source.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))).length
    if (count) hits[relative(root, file).replaceAll('\\', '/')] = count
  }
  return hits
}

function scan(rule: Rule): Record<string, number> {
  const hits: Record<string, number> = {}
  const files = rule.id === 'c2_runtime_stale_frame' ? runtimeContractFiles() : productionSourceFiles()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const count = Array.from(source.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))).length
    if (count) hits[relative(root, file).replaceAll('\\', '/')] = count
  }
  return hits
}

function runtimeContractErrors(file: string, source: string): string[] {
  return namedArities(source, 'applyRuntimeTarget')
    .filter((arity) => arity !== 1)
    .map(() => `${file}: applyRuntimeTarget must have exactly one parameter or argument`)
}

function namedArities(source: string, name: string): number[] {
  const arities: number[] = []
  const startPattern = new RegExp(`\\b${name}\\s*\\(`, 'g')
  for (const match of source.matchAll(startPattern)) {
    const open = source.indexOf('(', match.index)
    let parens = 1
    let braces = 0
    let brackets = 0
    let commas = 0
    let hasValue = false
    let quote = ''
    for (let index = open + 1; index < source.length; index++) {
      const char = source[index] ?? ''
      const next = source[index + 1]
      if (quote) {
        if (char === '\\') index++
        else if (char === quote) quote = ''
        continue
      }
      if (char === '/' && next === '/') {
        const newline = source.indexOf('\n', index + 2)
        index = newline < 0 ? source.length : newline
        continue
      }
      if (char === '/' && next === '*') {
        const close = source.indexOf('*/', index + 2)
        index = close < 0 ? source.length : close + 1
        continue
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char
        hasValue = true
        continue
      }
      if (char === '(') parens++
      else if (char === ')') {
        parens--
        if (!parens) {
          arities.push(hasValue ? commas + 1 : 0)
          break
        }
      } else if (char === '{') braces++
      else if (char === '}') braces--
      else if (char === '[') brackets++
      else if (char === ']') brackets--
      else if (char === ',' && parens === 1 && braces === 0 && brackets === 0) commas++
      else if (!/\s/.test(char) && parens === 1) hasValue = true
    }
  }
  return arities
}

const preparedSymbols =
  /\b(?:PreparedPluginInvocation|preparePluginInvocation|normalizePreparedConfig|pluginPrepared)\b/g
const preparedOwnerFiles = new Set([
  'packages/cordis/src/host.ts',
  'packages/plugin-runtime/src/row-mount.ts',
])

function preparedOwnerErrors(files: string[]): string[] {
  return files.flatMap((file) =>
    preparedOwnerError(relative(root, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')),
  )
}

function preparedOwnerError(path: string, source: string): string[] {
  if (preparedOwnerFiles.has(path)) return []
  const found = preparedSymbols.test(source)
  preparedSymbols.lastIndex = 0
  return found ? [`${path} accesses the prepared installer API`] : []
}

describe('Cordis runtime architecture guards', () => {
  const allowlistPath = join(root, 'tools/guards/cordis-migration-symbols-allowlist.json')
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as {
    version: number
    rules: Record<string, Record<string, number>>
  }
  it('uses the exact-count allowlist schema', () => {
    expect(allowlist.version).toBe(1)
    expect(Object.keys(allowlist).sort()).toEqual(['rules', 'version'])
    for (const paths of Object.values(allowlist.rules)) {
      for (const [path, count] of Object.entries(paths)) {
        expect(path.startsWith('packages/')).toBe(true)
        expect(Number.isSafeInteger(count) && count > 0).toBe(true)
      }
    }
    const knownRules = new Set(migrationRules.map((rule) => rule.id))
    for (const id of Object.keys(allowlist.rules)) expect(knownRules.has(id), `unknown rule ${id}`).toBe(true)
  })
  for (const rule of migrationRules) {
    it(`${rule.id} has no unreviewed production hits`, () => {
      expect(
        scan(rule),
        `update ${relative(root, allowlistPath)} only with a reviewed design change`,
      ).toEqual(allowlist.rules[rule.id] ?? {})
    })
  }

  for (const rule of sessionEnvironmentRules) {
    it(`${rule.id} stays absent from the shared-worker contract`, () => {
      expect(scanFiles(rule, runtimeContractFiles())).toEqual({})
    })
  }

  it('keeps Host runtime target application single-argument', () => {
    const actual = productionSourceFiles().flatMap((file) =>
      runtimeContractErrors(relative(root, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')),
    )
    expect(actual).toEqual([])
    expect(runtimeContractErrors('bad.ts', 'host.applyRuntimeTarget(tree, resource)')).toEqual([
      'bad.ts: applyRuntimeTarget must have exactly one parameter or argument',
    ])
    expect(
      runtimeContractErrors('bad.ts', 'interface Host { applyRuntimeTarget(tree: T, resource: R): void }'),
    ).toEqual(['bad.ts: applyRuntimeTarget must have exactly one parameter or argument'])
    expect(runtimeContractErrors('good.ts', 'host.applyRuntimeTarget(target)')).toEqual([])
  })

  it('keeps the prepared installer API in its two internal owner files', () => {
    expect(preparedOwnerErrors(productionSourceFiles())).toEqual([])
    expect(preparedOwnerError('packages/host/src/bad.ts', 'pluginPrepared(ctx, prepared, config)')).toEqual([
      'packages/host/src/bad.ts accesses the prepared installer API',
    ])
    expect(
      preparedOwnerError('packages/plugin-runtime/src/row-mount.ts', 'pluginPrepared(ctx, prepared, config)'),
    ).toEqual([])
    expect(preparedOwnerFiles).toEqual(
      new Set(['packages/cordis/src/host.ts', 'packages/plugin-runtime/src/row-mount.ts']),
    )
  })
})
