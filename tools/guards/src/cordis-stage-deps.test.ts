import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXCLUDE_DIRS,
  isTestFile,
  listPackages,
  listSourceFiles,
  type Package,
  repoRoot,
} from './repo.js'

const root = repoRoot()
const CORDIS = '@agnes/cordis'
const LOADER = '@agnes/cordis-loader'
const RUNTIME = '@agnes/plugin-runtime'
const HOST = '@agnes/host'
const PACKAGE_MANAGER = '@agnes/package-manager'
const WORKER_RUNTIME = '@agnes/worker-runtime'
const DAEMON = '@agnes/daemon'
const NEW_FOUNDATION_PACKAGES = [LOADER, RUNTIME] as const

type ImportSite = { packageName: string; file: string; line: number; specifier: string }
type PackageShape = {
  name: string
  dependencies: string[]
  exports: Record<string, string>
  rootIndex?: string
}

const POST_TASK8_FOUNDATION_SYMBOLS = /\b(?:ResourceGenerationCell|CompositeTargetStore|CandidateRuntime)\b/g
const INTERNAL_ROOT_SYMBOLS =
  /\b(?:PreparedPluginInvocation|CandidateRuntime|RuntimePublicationTransaction|PreparedGeneration|VerifiedMountAuthority|BuiltinRowMountFactory|HostProvideCapability|VerifiedRowInstallation)\b/g

function packageShape(pkg: Package): PackageShape {
  const dependencies = {
    ...(pkg.json.dependencies as Record<string, string> | undefined),
    ...(pkg.json.peerDependencies as Record<string, string> | undefined),
  }
  const exports = pkg.json.exports as Record<string, string> | string | undefined
  return {
    name: pkg.name,
    dependencies: Object.keys(dependencies),
    exports: typeof exports === 'string' ? { '.': exports } : (exports ?? {}),
    ...(existsSync(join(pkg.dir, 'src/index.ts'))
      ? { rootIndex: readFileSync(join(pkg.dir, 'src/index.ts'), 'utf8') }
      : {}),
  }
}

function productionImports(packages: Package[]): ImportSite[] {
  const imports: ImportSite[] = []
  const pattern = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|^\s*import\s*)(['"])(@agnes\/[^'"]+)\1/gm
  for (const pkg of packages) {
    for (const file of listSourceFiles(join(pkg.dir, 'src'), {
      excludeDirs: [...DEFAULT_EXCLUDE_DIRS, 'fixtures', 'test', 'tests', 'testkit', '__tests__'],
    }).filter((candidate) => !isTestFile(candidate))) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(pattern)) {
        const specifier = match[2]
        if (!specifier) continue
        const line = source.slice(0, match.index).split('\n').length
        imports.push({
          packageName: pkg.name,
          file: relative(root, file).replaceAll('\\', '/'),
          line,
          specifier,
        })
      }
    }
  }
  return imports.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`))
}

function foundationPhaseErrors(packages: Package[]): string[] {
  const errors: string[] = []
  for (const pkg of packages) {
    if (!NEW_FOUNDATION_PACKAGES.includes(pkg.name as (typeof NEW_FOUNDATION_PACKAGES)[number])) continue
    for (const file of listSourceFiles(join(pkg.dir, 'src'), {
      excludeDirs: [...DEFAULT_EXCLUDE_DIRS, 'fixtures', 'test', 'tests', 'testkit', '__tests__'],
    }).filter((candidate) => !isTestFile(candidate))) {
      errors.push(
        ...foundationSourceErrors(relative(root, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')),
      )
    }
  }
  return errors.sort()
}

function foundationSourceErrors(path: string, source: string): string[] {
  const matches = Array.from(source.matchAll(POST_TASK8_FOUNDATION_SYMBOLS), (match) => match[0])
  return matches.length ? [`${path} contains post-Task8 ${[...new Set(matches)].join(', ')}`] : []
}

function isPackage(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`)
}

export function auditStageGraph(packages: PackageShape[], imports: ImportSite[]): string[] {
  const errors: string[] = []
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const loaderExists = byName.has(LOADER)
  const runtimeExists = byName.has(RUNTIME)
  if (loaderExists !== runtimeExists)
    errors.push('cordis-loader and plugin-runtime must enter the workspace together')

  if (!loaderExists) {
    for (const pkg of packages) {
      for (const dep of pkg.dependencies) {
        if (NEW_FOUNDATION_PACKAGES.some((name) => isPackage(dep, name))) {
          errors.push(`${pkg.name} declares missing foundation dependency ${dep}`)
        }
      }
    }
    for (const site of imports) {
      if (NEW_FOUNDATION_PACKAGES.some((name) => isPackage(site.specifier, name))) {
        errors.push(`${site.file}:${site.line} imports missing foundation package ${site.specifier}`)
      }
    }
  }

  const allowedFoundationDependencies: Record<string, Set<string>> = {
    [CORDIS]: new Set(['@agnes/cosmokit']),
    [LOADER]: new Set([CORDIS, '@agnes/cosmokit']),
    [RUNTIME]: new Set([CORDIS, LOADER, '@agnes/cosmokit']),
  }
  for (const [name, allowed] of Object.entries(allowedFoundationDependencies)) {
    const pkg = byName.get(name)
    if (!pkg) continue
    for (const dep of pkg.dependencies.filter((item) => item.startsWith('@agnes/'))) {
      if (!allowed.has(dep)) errors.push(`${name} must not depend on ${dep}`)
    }
  }

  for (const site of imports) {
    if (
      site.packageName === CORDIS &&
      [LOADER, RUNTIME, HOST].some((name) => isPackage(site.specifier, name))
    ) {
      errors.push(`${site.file}:${site.line} reverses the Cordis foundation dependency`)
    }
    if (site.packageName === LOADER && [RUNTIME, HOST].some((name) => isPackage(site.specifier, name))) {
      errors.push(`${site.file}:${site.line} reverses the loader dependency`)
    }
    if (site.packageName === RUNTIME && isPackage(site.specifier, HOST)) {
      errors.push(`${site.file}:${site.line} reverses the plugin-runtime dependency`)
    }
    if (site.specifier === `${RUNTIME}/testkit`) {
      errors.push(`${site.file}:${site.line} imports testkit from production source`)
    }
    if (
      site.specifier === `${RUNTIME}/host` &&
      site.packageName !== HOST &&
      site.packageName !== PACKAGE_MANAGER &&
      site.packageName !== WORKER_RUNTIME &&
      site.packageName !== DAEMON
    ) {
      errors.push(
        `${site.file}:${site.line} imports the plugin-runtime Host API outside its Host/runtime owners`,
      )
    }
    if (site.specifier === `${CORDIS}/host` && site.file !== 'packages/plugin-runtime/src/row-mount.ts') {
      errors.push(`${site.file}:${site.line} imports the Cordis Host-only API outside row-mount.ts`)
    }
  }

  const cordis = byName.get(CORDIS)
  if (cordis) {
    const keys = Object.keys(cordis.exports).sort()
    if (keys.some((key) => !['.', './host'].includes(key)))
      errors.push(`cordis exports unexpected subpaths: ${keys.join(', ')}`)
    if (cordis.exports['.'] !== './src/index.ts') errors.push('cordis root export must remain ./src/index.ts')
    if (cordis.exports['./host'] && cordis.exports['./host'] !== './src/host.ts') {
      errors.push('cordis ./host must point to ./src/host.ts')
    }
    if (
      cordis.rootIndex &&
      /(?:from\s+['"]\.\/host|export\s+\*\s+from\s+['"]\.\/host)/.test(cordis.rootIndex)
    ) {
      errors.push('cordis root must not re-export the Host-only API')
    }
    if (cordis.rootIndex && INTERNAL_ROOT_SYMBOLS.test(cordis.rootIndex)) {
      errors.push('cordis root must not expose prepared or Host-only symbols')
      INTERNAL_ROOT_SYMBOLS.lastIndex = 0
    }
  }

  const loader = byName.get(LOADER)
  if (loader && Object.keys(loader.exports).sort().join(',') !== '.') {
    errors.push('cordis-loader may export only the package root')
  }

  const runtime = byName.get(RUNTIME)
  if (runtime) {
    const keys = Object.keys(runtime.exports).sort()
    if (keys.some((key) => !['.', './host', './testkit'].includes(key))) {
      errors.push(`plugin-runtime exports unexpected subpaths: ${keys.join(', ')}`)
    }
    for (const [key, target] of Object.entries(runtime.exports)) {
      if (/row-mount|internal\//.test(target))
        errors.push(`plugin-runtime export ${key} exposes private installer ${target}`)
    }
    if (runtime.rootIndex && /(?:\.\/host|\.\/testkit|row-mount|internal\/)/.test(runtime.rootIndex)) {
      errors.push('plugin-runtime root must not re-export Host/testkit/private installer modules')
    }
    if (runtime.rootIndex && INTERNAL_ROOT_SYMBOLS.test(runtime.rootIndex)) {
      errors.push('plugin-runtime root must not expose Host-only runtime symbols')
      INTERNAL_ROOT_SYMBOLS.lastIndex = 0
    }
  }

  return errors.sort()
}

describe('Agnes on Cordis stage dependency guard', () => {
  it('accepts the pre-C1 graph without being vacuous', () => {
    const packages = listPackages(root)
    expect(auditStageGraph(packages.map(packageShape), productionImports(packages))).toEqual([])
    expect(foundationPhaseErrors(packages)).toEqual([])
    expect(
      foundationSourceErrors('packages/plugin-runtime/src/bad.ts', 'type X = ResourceGenerationCell'),
    ).toEqual(['packages/plugin-runtime/src/bad.ts contains post-Task8 ResourceGenerationCell'])
    expect(foundationSourceErrors('packages/plugin-runtime/src/good.ts', 'type X = RuntimeTarget')).toEqual(
      [],
    )

    const cordis: PackageShape = {
      name: CORDIS,
      dependencies: ['@agnes/cosmokit'],
      exports: { '.': './src/index.ts' },
    }
    const base: PackageShape[] = [cordis]
    expect(
      auditStageGraph(
        [...base, { name: LOADER, dependencies: [CORDIS], exports: { '.': './src/index.ts' } }],
        [],
      ),
    ).toContain('cordis-loader and plugin-runtime must enter the workspace together')
    expect(auditStageGraph([{ ...cordis, dependencies: [LOADER] }], [])).toContain(
      `${CORDIS} must not depend on ${LOADER}`,
    )
  })

  it('keeps Cordis, loader and runtime dependencies one-way', () => {
    const packages: PackageShape[] = [
      { name: CORDIS, dependencies: ['@agnes/cosmokit'], exports: { '.': './src/index.ts' } },
      { name: LOADER, dependencies: [CORDIS], exports: { '.': './src/index.ts' } },
      { name: RUNTIME, dependencies: [CORDIS, LOADER], exports: { '.': './src/index.ts' } },
    ]
    expect(auditStageGraph(packages, [])).toEqual([])
    expect(
      auditStageGraph(packages, [
        { packageName: LOADER, file: 'packages/cordis-loader/src/bad.ts', line: 1, specifier: RUNTIME },
      ]),
    ).toContain('packages/cordis-loader/src/bad.ts:1 reverses the loader dependency')
    expect(
      auditStageGraph(packages, [
        { packageName: RUNTIME, file: 'packages/plugin-runtime/src/bad.ts', line: 1, specifier: HOST },
      ]),
    ).toContain('packages/plugin-runtime/src/bad.ts:1 reverses the plugin-runtime dependency')
  })

  it('keeps host-only and testkit subpaths out of production consumers', () => {
    const packages: PackageShape[] = [
      {
        name: CORDIS,
        dependencies: ['@agnes/cosmokit'],
        exports: { '.': './src/index.ts', './host': './src/host.ts' },
      },
      { name: LOADER, dependencies: [CORDIS], exports: { '.': './src/index.ts' } },
      {
        name: RUNTIME,
        dependencies: [CORDIS, LOADER],
        exports: {
          '.': './src/index.ts',
          './host': './src/host/index.ts',
          './testkit': './testkit/index.ts',
        },
      },
    ]
    const bad = auditStageGraph(packages, [
      { packageName: HOST, file: 'packages/host/src/bad.ts', line: 3, specifier: `${CORDIS}/host` },
      { packageName: HOST, file: 'packages/host/src/bad.ts', line: 4, specifier: `${RUNTIME}/testkit` },
      { packageName: '@agnes/code', file: 'packages/code/src/bad.ts', line: 5, specifier: `${RUNTIME}/host` },
    ])
    expect(bad).toContain('packages/host/src/bad.ts:3 imports the Cordis Host-only API outside row-mount.ts')
    expect(bad).toContain('packages/host/src/bad.ts:4 imports testkit from production source')
    expect(bad).toContain(
      'packages/code/src/bad.ts:5 imports the plugin-runtime Host API outside its Host/runtime owners',
    )
    expect(
      auditStageGraph(packages, [
        {
          packageName: RUNTIME,
          file: 'packages/plugin-runtime/src/row-mount.ts',
          line: 1,
          specifier: `${CORDIS}/host`,
        },
      ]),
    ).toEqual([])
    expect(
      auditStageGraph(packages, [
        {
          packageName: WORKER_RUNTIME,
          file: 'packages/worker-runtime/src/runtime-target-slot.ts',
          line: 1,
          specifier: `${RUNTIME}/host`,
        },
      ]),
    ).toEqual([])
    expect(
      auditStageGraph(packages, [
        {
          packageName: PACKAGE_MANAGER,
          file: 'packages/package-manager/src/package-plugin-loader.ts',
          line: 1,
          specifier: `${RUNTIME}/host`,
        },
      ]),
    ).toEqual([])
  })

  it('keeps private installer files out of package exports', () => {
    const packages: PackageShape[] = [
      { name: CORDIS, dependencies: ['@agnes/cosmokit'], exports: { '.': './src/index.ts' } },
      { name: LOADER, dependencies: [CORDIS], exports: { '.': './src/index.ts' } },
      {
        name: RUNTIME,
        dependencies: [CORDIS, LOADER],
        exports: { '.': './src/index.ts', './row-mount': './src/row-mount.ts' },
      },
    ]
    expect(auditStageGraph(packages, [])).toContain(
      'plugin-runtime export ./row-mount exposes private installer ./src/row-mount.ts',
    )
    expect(
      auditStageGraph(
        [
          packages[0] as PackageShape,
          packages[1] as PackageShape,
          {
            ...(packages[2] as PackageShape),
            exports: { '.': './src/index.ts' },
            rootIndex: 'export { CandidateRuntime }',
          },
        ],
        [],
      ),
    ).toContain('plugin-runtime root must not expose Host-only runtime symbols')
  })
})
