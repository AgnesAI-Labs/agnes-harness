import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXCLUDE_DIRS, isTestFile, listPackages, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
const allow = JSON.parse(
  readFileSync(join(root, 'tools/guards/dependency-allowlist.json'), 'utf8'),
) as Record<string, string[]>

describe('dependency allowlist (dependencies point one way, downward)', () => {
  for (const pkg of listPackages(root)) {
    it(`${pkg.name} only depends on allowed @agnes packages`, () => {
      const deps = {
        ...(pkg.json.dependencies as Record<string, string> | undefined),
        ...(pkg.json.peerDependencies as Record<string, string> | undefined),
        // devDependencies are not checked: build-time and test-time dependencies (such as the
        // typescript/vitest devDependency every package shares) are never imported into the shipped
        // output at runtime, so they cannot violate the runtime layering this rule constrains. If a
        // devDependency ever turns out to be a fig leaf for something runtime code actually imports,
        // the fix is to scan the import statements in source, not to start checking devDependencies
        // here.
      }
      if (pkg.name === '@agnes/plugin-runtime') {
        expect(pkg.json.dependencies).not.toHaveProperty('@agnes/host')
        expect(
          (pkg.json.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined)?.[
            '@agnes/host'
          ]?.optional,
        ).toBe(true)
        delete deps['@agnes/host']
      }
      const agnesDeps = Object.keys(deps).filter((d) => d.startsWith('@agnes/'))
      const allowed = allow[pkg.name]
      expect(allowed, `${pkg.name} missing from dependency-allowlist.json`).toBeDefined()
      for (const d of agnesDeps) expect(allowed, `${pkg.name} → ${d} not allowed`).toContain(d)
    })
  }
  it('every allowlist entry is a real package', () => {
    const names = new Set(listPackages(root).map((p) => p.name))
    for (const n of Object.keys(allow)) expect(names.has(n), n).toBe(true)
  })
})

// The check above only verifies that the actual dependencies are a subset of the table, and the table
// itself can be edited to say anything — putting "@agnes/protocol": ["@agnes/core"] into the allowlist
// would stay green. This adds an assertion that the table agrees with the layering.
// Layer order, lowest to highest:
//   protocol(0) < extension-api(1) < core(2) < ai(3) < base(4) < code(5)
//   < runtime-python(6) < host(7)
//   / sdk(3, see the special cases below) / daemon(8) / channels(9) / bridges(9) / cli(10)
//
// Deliberate deviation: the source layering placed cli, channels and bridges together on layer 8.
// But dependency-allowlist.json has long and legitimately had cli depending on bridges, with no
// objection raised in review, and putting cli on the same layer as channels/bridges would make
// cli → bridges go red under "same layer is not strictly lower". That is not a real violation; the
// layer table was simply too coarse about where cli sits. cli is the outermost entry point composing
// adapter packages like bridges and channels, so it semantically belongs one layer above them. cli is
// therefore 9 here, with channels/bridges still together on 8, which lets every existing and
// previously approved dependency in the code pass.
const LAYER: Record<string, number> = {
  '@agnes/e2e-web': 11, // Private acceptance client consumes only the public SDK and protocol.
  // Vendored Cordis core and utilities: third-party code, no @agnes layer (web-client-modules WC4).
  '@agnes/cosmokit': -2, // zero-dependency leaf, below the vendor core (system-node precedent)
  '@agnes/cordis': -1,
  '@agnes/cordis-loader': 0,
  '@agnes/plugin-runtime': 1,
  '@agnes/web-slots': -1,
  // UI component layer (web-ui component system, spec 2026-09-24): the only package allowed to
  // import antd/@assistant-ui (enforced by ui-layer.test.ts). Sits just above protocol so it can
  // consume UINode types; external UI libraries are npm deps, not @agnes layers.
  '@agnes/web-ui': 1,
  // Raised from 1 to 2 when web-ui landed: web-units consumes web-ui components, and the
  // "strictly lower" rule forbids same-layer imports. Only web(10) consumes web-units.
  '@agnes/web-units': 2,
  // Author-facing browser API above sdk (web-client-modules WC6); react is a pinned peer, not a layer.
  '@agnes/web-client': 4,
  '@agnes/resource-control-contracts': -1,
  '@agnes/mcp-transport-health': -1,
  '@agnes/protocol-validation': -1,
  '@agnes/error-sanitization': -1,
  '@agnes/package-isolation': -1,
  '@agnes/system-node': -2, // OS primitives sit below infrastructure leaves and have no package dependencies.
  '@agnes/web-server': 1,
  '@agnes/web-admin-frame': -1,
  '@agnes/protocol': 0,
  '@agnes/resource-control-client-node': 2,
  '@agnes/package-admin-client-node': 2,
  '@agnes/cli-launch': 1,
  '@agnes/cli-tui': 4,
  '@agnes/resource-control-runtime': 6,
  '@agnes/resource-control-store': 6,
  '@agnes/resource-control-web': 9,
  '@agnes/resource-control-worker': 7,
  '@agnes/resource-control-daemon': 7,
  '@agnes/worker-runtime': 8,
  '@agnes/resource-control-cli': 10,
  '@agnes/history-index': 0,
  '@agnes/extension-api': 1,
  '@agnes/core-common': 1.1,
  '@agnes/core-child-control': 1.2,
  '@agnes/core-ledger': 1.3,
  '@agnes/core-effects': 1.4,
  '@agnes/core-artifacts': 1.1,
  '@agnes/core': 2,
  '@agnes/loop-default': 2, // First-party loop plugin consumes the author API.

  '@agnes/ai': 3,
  '@agnes/model-adapters': 4,
  // A seam-only package (RA16): implements SandboxSeam against a transport handed to it by the
  // host adapter layer, without depending on host or base. Same layer as ai/sdk - one above core,
  // the only thing it depends on.
  '@agnes/sandbox-remote': 3,
  '@agnes/base': 4,
  '@agnes/code': 5,
  '@agnes/runtime-python': 6,
  '@agnes/package-manager': 2,
  '@agnes/host-common': 6.01,
  '@agnes/host-infrastructure': 6.02,
  '@agnes/host-computer-use': 6.03,
  '@agnes/host-artifacts': 6.04,
  '@agnes/host-extensions': 6.05,
  '@agnes/host-providers': 6.06,
  '@agnes/host-runtime': 6.07,
  '@agnes/host': 7,
  '@agnes/sdk': 3,
  '@agnes/daemon-foundation': 8.1,
  '@agnes/daemon': 9,
  // Channel's outer client launcher consumes the daemon's public discovery reader, like other clients.
  '@agnes/channels': 10,
  '@agnes/bridges': 9,
  '@agnes/web': 10,
  // CLI's serve command composes the public Node static server; Web still depends only on SDK/protocol.
  '@agnes/cli': 11,
}

// Special cases: their layer numbers would allow sdk and extension-api to depend on anything at or
// below their own layer, but they are tightened further to protocol only; guards has no layer number
// at all and is allowed an empty table only. Both rules are stricter than the layer comparison, so they
// are asserted separately rather than going through it.
const EXACT_ONLY: Record<string, string[]> = {
  '@agnes/cordis-loader': ['@agnes/cordis'],
  '@agnes/plugin-runtime': ['@agnes/cordis', '@agnes/cordis-loader', '@agnes/extension-api'],
  '@agnes/sdk': [
    '@agnes/protocol',
    '@agnes/resource-control-client-node',
    '@agnes/package-admin-client-node',
    '@agnes/system-node', // Node-only private file journal; browser entry stays free of native imports.
  ],
  '@agnes/extension-api': ['@agnes/protocol'],
  '@agnes/guards': [],
}

describe('dependency allowlist matches layer order', () => {
  for (const [pkg, allowedDeps] of Object.entries(allow)) {
    it(`${pkg}: allowlist entries are consistent with the layer table`, () => {
      const exact = EXACT_ONLY[pkg]
      if (exact) {
        expect([...allowedDeps].sort(), `${pkg} must allow exactly ${JSON.stringify(exact)}`).toEqual(
          [...exact].sort(),
        )
        return
      }
      const layer = LAYER[pkg]
      expect(layer, `${pkg} missing from layer table`).toBeDefined()
      for (const dep of allowedDeps) {
        const depLayer = LAYER[dep]
        expect(depLayer, `${dep} missing from layer table`).toBeDefined()
        expect(
          depLayer,
          `${pkg}(layer ${layer}) → ${dep}(layer ${depLayer}) is not strictly lower-layer`,
        ).toBeLessThan(layer as number)
      }
    })
  }
})

// Test fixtures can depend on higher layers. Production imports, including type queries and
// literal dynamic imports, must use declared downward dependencies rather than devDependencies.
function importedModules(source: string): string[] {
  const text = source.replace(
    /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, literal: string | undefined) => literal ?? ' '.repeat(match.length),
  )
  return [...text.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)].map(
    (match) => match[1] as string,
  )
}

function dependencyCycles(graph: Map<string, Set<string>>): string[] {
  const done = new Set<string>()
  const stack: string[] = []
  const cycles: string[] = []
  const visit = (name: string) => {
    if (stack.includes(name)) {
      cycles.push([...stack.slice(stack.indexOf(name)), name].join(' → '))
      return
    }
    if (done.has(name)) return
    stack.push(name)
    for (const dep of graph.get(name) ?? []) visit(dep)
    stack.pop()
    done.add(name)
  }
  for (const name of graph.keys()) visit(name)
  return cycles
}

it('production source and manifests form declared, acyclic package graphs', () => {
  const packages = listPackages(root)
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const sourceGraph = new Map<string, Set<string>>()
  const manifestGraph = new Map<string, Set<string>>()
  const errors: string[] = []
  // Schema-owned compatibility modules predate the workspace split. Keep these exact existing
  // imports visible; new private cross-package paths are rejected, including in split packages.
  const legacyPaths = new Set([
    'packages/protocol/src/json-data.ts:../../protocol-validation/src/json-data.js',
    'packages/protocol/src/request-media.ts:../../protocol-validation/src/validate.js',
    'packages/protocol/src/resource-control.ts:../../resource-control-contracts/src/resource-control.js',
    'packages/protocol/src/validate.ts:../../protocol-validation/src/validate.js',
    'packages/protocol/src/validate.ts:../../protocol-validation/src/attachments.js',
    'packages/protocol/src/validate.ts:../../protocol-validation/src/model-images.js',
    'packages/protocol/src/validate.ts:../../protocol-validation/src/safe-image.js',
  ])
  for (const pkg of packages) {
    const declared = {
      ...(pkg.json.dependencies as Record<string, string> | undefined),
      ...(pkg.json.peerDependencies as Record<string, string> | undefined),
    }
    // Optional Host peer supports testkit activation only, never production plugin code.
    if (pkg.name === '@agnes/plugin-runtime') delete declared['@agnes/host']
    const edges = new Set<string>()
    sourceGraph.set(pkg.name, edges)
    manifestGraph.set(pkg.name, new Set(Object.keys(declared).filter((name) => byName.has(name))))
    for (const file of listSourceFiles(pkg.dir, {
      excludeDirs: [...DEFAULT_EXCLUDE_DIRS, 'test', 'tests', 'testkit', 'fixtures', 'tools', 'scripts'],
    })) {
      if (isTestFile(file) || file.endsWith('vitest.config.ts')) continue
      for (const spec of importedModules(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec)
          const owner = packages.find((candidate) => target.startsWith(`${candidate.dir}${sep}`))
          if (owner && owner !== pkg) {
            edges.add(owner.name)
            if (!legacyPaths.has(`${relative(root, file)}:${spec}`)) {
              errors.push(`${relative(root, file)} imports private path ${spec}`)
            }
          }
          continue
        }
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (!name || !byName.has(name) || name === pkg.name) continue
        edges.add(name)
        if (!(name in declared)) errors.push(`${relative(root, file)} imports undeclared ${spec}`)
      }
    }
  }
  expect(errors).toEqual([])
  expect(dependencyCycles(manifestGraph), 'production manifest cycles').toEqual([])
  expect(dependencyCycles(sourceGraph), 'production source cycles').toEqual([])
})

it('detects fixture back-edges, type queries and literal dynamic imports', () => {
  expect(
    importedModules(`
    // import('@agnes/ignored')
    import type { X } from '@agnes/a'
    export { Y } from '@agnes/b/subpath'
    type Z = import('@agnes/c').Z
    const load = () => import('@agnes/d')
    import '@agnes/e'
  `),
  ).toEqual(['@agnes/a', '@agnes/b/subpath', '@agnes/c', '@agnes/d', '@agnes/e'])
  expect(
    dependencyCycles(
      new Map([
        ['leaf', new Set(['root'])],
        ['root', new Set(['leaf'])],
      ]),
    ),
  ).toEqual(['leaf → root → leaf'])
})
