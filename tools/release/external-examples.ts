#!/usr/bin/env -S node --import tsx
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SyntaxKind } from 'typescript/unstable/ast'
import { createScanner } from 'typescript/unstable/ast/scanner'
import { AGH_DIR } from '../../packages/protocol/src/index.js'
import { packNpxPackage } from './pack-npx.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const authorPackages = [
  'extension-api',
  'plugin-runtime',
  'resource-control-runtime',
  // UI data-source plugins import this kind token. Pack it with the other author tarballs.
  'intelligent-ui-contract',
]
type Manifest = {
  name: string
  version: string
  exports: string | Record<string, unknown>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, unknown>
  license?: string
}

function inside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

async function manifests(): Promise<Map<string, { directory: string; manifest: Manifest }>> {
  const result = new Map<string, { directory: string; manifest: Manifest }>()
  for (const entry of await readdir(join(repo, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(repo, 'packages', entry.name)
    if (!existsSync(join(directory, 'package.json'))) continue
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
    result.set(manifest.name, { directory, manifest })
  }
  return result
}

/** Reject source imports that only happen to work inside the monorepo. */
export async function validateExample(directory: string): Promise<void> {
  const packages = await manifests()
  async function check(specifier: string, file: string) {
    if (specifier.startsWith('.')) {
      if (
        specifier.split('/').includes('node_modules') ||
        !inside(directory, resolve(dirname(file), specifier))
      )
        throw new Error(`Workspace-relative or private import in ${file}: ${specifier}`)
      return
    }
    if (isAbsolute(specifier) || specifier.startsWith('file:'))
      throw new Error(`Absolute import in ${file}: ${specifier}`)
    if (!specifier.startsWith('@agnes/')) return
    const [scope, leaf, ...subpath] = specifier.split('/')
    const name = `${scope}/${leaf}`
    const key = subpath.length ? `./${subpath.join('/')}` : '.'
    const manifest = packages.get(name)?.manifest
    const exports = typeof manifest?.exports === 'string' ? { '.': manifest.exports } : manifest?.exports
    const declared =
      exports &&
      Object.keys(exports).some((candidate) => {
        if (!candidate.includes('*')) return candidate === key
        const [before, after = ''] = candidate.split('*')
        return key.startsWith(before!) && key.endsWith(after)
      })
    if (
      !declared ||
      (name === '@agnes/plugin-runtime' &&
        key !== '.' &&
        key !== './testkit' &&
        key !== './deferred-contract')
    ) {
      throw new Error(`Private or undeclared module import in ${file}: ${specifier}`)
    }
  }
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
      const file = join(path, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Example contains a symlink: ${file}`)
      if (entry.isDirectory()) {
        await walk(file)
        continue
      }
      if (entry.name === 'package.json') {
        const manifest = JSON.parse(await readFile(file, 'utf8'))
        for (const deps of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]) {
          for (const version of Object.values(deps ?? {})) {
            if (typeof version !== 'string' || /^(?:workspace:|link:|file:|\/)/.test(version))
              throw new Error(`Nonportable dependency in ${file}: ${version}`)
          }
        }
      }
      if (!/\.(?:[cm]?js|tsx?)$/.test(entry.name)) continue
      const scanner = createScanner(true, 0, await readFile(file, 'utf8'))
      const kindOf = (text: string) => createScanner(true, 0, text).scan()
      const eof = kindOf(''),
        string = kindOf("'module'"),
        template = kindOf('`module`')
      const tokens: { kind: number; text: string; value: string }[] = []
      const templateBraces: number[] = []
      for (let kind = scanner.scan(); kind !== eof; kind = scanner.scan()) {
        if (kind === SyntaxKind.OpenBraceToken && templateBraces.length)
          templateBraces[templateBraces.length - 1]!++
        if (kind === SyntaxKind.CloseBraceToken && templateBraces.length) {
          if (templateBraces.at(-1) === 0) kind = scanner.reScanTemplateToken(false)
          else templateBraces[templateBraces.length - 1]!--
        }
        if (kind === SyntaxKind.TemplateHead) templateBraces.push(0)
        if (kind === SyntaxKind.TemplateTail) templateBraces.pop()
        // The lexical scanner requires template continuation rescanning. Unsupported
        // syntax must fail boundedly instead of accumulating zero-length tokens forever.
        if (scanner.getTokenEnd() <= scanner.getTokenStart())
          throw new Error(`Source scanner made no progress in ${file}`)
        tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() })
      }
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!
        const next = tokens[i + 1]
        if (token.text === 'from' || (token.text === 'import' && next?.kind === string)) {
          if (next?.kind === string) await check(next.value, file)
        } else if ((token.text === 'import' || token.text === 'require') && next?.text === '(') {
          const argument = tokens[i + 2]
          if (!argument || ![string, template].includes(argument.kind) || tokens[i + 3]?.text !== ')')
            throw new Error(`Nonliteral module import in ${file}`)
          await check(argument.value, file)
        }
      }
    }
  }
  await walk(directory)
}

function compiledExports(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('./dist/') || value.endsWith('.mjs')) return value
    if (!value.endsWith('.ts')) throw new Error(`Unsupported source export: ${value}`)
    const base = value.slice(2, -3)
    return { types: `./dist/${base}.d.ts`, import: `./dist/${base}.js`, default: `./dist/${base}.js` }
  }
  if (!value || typeof value !== 'object') throw new Error('Missing package exports')
  return Object.fromEntries(Object.entries(value).map(([key, target]) => [key, compiledExports(target)]))
}

function environment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: (process.env.PATH ?? '')
      .split(sep === '/' ? ':' : ';')
      .filter((path) => !path.includes('node_modules'))
      .join(sep === '/' ? ':' : ';'),
    HOME: home,
    USERPROFILE: home,
    AGH_HOME: join(home, AGH_DIR),
    TMPDIR: tmpdir(),
    SystemRoot: process.env.SystemRoot,
    LANG: 'en_US.UTF-8',
    CI: '1',
    GOMAXPROCS: process.env.GOMAXPROCS,
    GOMEMLIMIT: process.env.GOMEMLIMIT,
    npm_config_cache: join(home, '.npm'),
    npm_config_userconfig: join(home, '.npmrc'),
  }
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  execFileSync(command, args, { cwd, env: env ?? process.env, stdio: 'inherit', timeout: 120_000 })
}

async function pack(directory: string, output: string, env: NodeJS.ProcessEnv): Promise<string> {
  const json = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], {
    cwd: directory,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  const entry = (JSON.parse(json) as { filename?: string }[])[0]
  if (!entry?.filename) throw new Error(`npm pack did not return a tarball for ${directory}`)
  return join(output, entry.filename)
}

async function notices(source: string, target: string): Promise<void> {
  for (const name of ['LICENSE', 'NOTICE', 'VENDORED.md']) {
    const file = existsSync(join(source, name)) ? join(source, name) : join(repo, name)
    if (existsSync(file)) await copyFile(file, join(target, name))
  }
}

async function portableProtocolFacade(directory: string): Promise<void> {
  // Protocol currently re-exports these two packages through sibling source
  // paths. In a tarball they must resolve through the same declared public APIs.
  // Normalize staged JS and declarations without changing either owner's source.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) {
      await portableProtocolFacade(file)
      continue
    }
    if (!/\.(?:js|ts)$/.test(entry.name)) continue
    const original = await readFile(file, 'utf8')
    const portable = original.replace(
      /(['"])\.\.\/\.\.\/(protocol-validation|resource-control-contracts)\/src\/[^'"]+\1/g,
      (_match, quote, leaf) => `${quote}@agnes/${leaf}${quote}`,
    )
    if (portable !== original) await writeFile(file, portable)
  }
}

async function extensionManifests(directory: string): Promise<readonly unknown[]> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
    agnes?: { extensions?: readonly string[] }
  }
  return Promise.all(
    (manifest.agnes?.extensions ?? []).map(async (path) =>
      JSON.parse(await readFile(join(directory, path, 'agnes.extension.json'), 'utf8')),
    ),
  )
}

async function packAuthors(root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const packages = await manifests()
  const needed = new Set<string>()
  function include(name: string) {
    if (needed.has(name)) return
    const entry = packages.get(name)
    if (!entry) throw new Error(`Unknown author package: ${name}`)
    needed.add(name)
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {}))
      if (packages.has(dependency)) include(dependency)
  }
  for (const leaf of authorPackages) include(`@agnes/${leaf}`)
  // Emit actual public declarations; do not synthesize an author API for the examples.
  run(
    'nice',
    [
      '-n',
      '10',
      process.execPath,
      join(repo, 'node_modules/typescript/bin/tsc'),
      '-b',
      ...authorPackages.map((leaf) => join(repo, 'packages', leaf)),
      join(repo, 'packages/plugin-runtime/tsconfig.testkit.json'),
    ],
    repo,
  )
  const tarballs: string[] = []
  for (const name of needed) {
    const { directory, manifest } = packages.get(name)!
    const stage = join(root, 'packages', name.split('/')[1]!)
    await mkdir(stage, { recursive: true })
    await cp(join(directory, 'dist'), join(stage, 'dist'), {
      recursive: true,
      filter: (path) => !/\.(?:test|slow|e2e)\./.test(path) && !path.endsWith('.tsbuildinfo'),
    })
    if (name === '@agnes/plugin-runtime') {
      // Its dedicated testkit project nests the public sources under outDir/testkit.
      // Overlay them at the source-shaped export path; ../src stays the production API.
      await cp(join(directory, 'dist/testkit/testkit'), join(stage, 'dist/testkit'), {
        recursive: true,
        filter: (path) => !/\.(?:test|slow|e2e)\./.test(path),
      })
      await rm(join(stage, 'dist/testkit/testkit'), { recursive: true, force: true })
    }
    if (name === '@agnes/protocol') await portableProtocolFacade(join(stage, 'dist'))
    for (const target of Object.values(
      typeof manifest.exports === 'string' ? { '.': manifest.exports } : manifest.exports,
    )) {
      if (typeof target === 'string' && target.endsWith('.mjs')) {
        await mkdir(dirname(join(stage, target)), { recursive: true })
        await copyFile(join(directory, target), join(stage, target))
      }
    }
    const dependencies = Object.fromEntries(
      Object.entries(manifest.dependencies ?? {}).map(([name, version]) => [
        name,
        packages.get(name)?.manifest.version ?? version,
      ]),
    )
    await writeFile(
      join(stage, 'package.json'),
      JSON.stringify(
        {
          name,
          version: manifest.version,
          type: 'module',
          exports: compiledExports(manifest.exports),
          dependencies,
          peerDependencies: manifest.peerDependencies,
          peerDependenciesMeta: manifest.peerDependenciesMeta,
          license: manifest.license,
          files: ['dist', 'runtime', 'LICENSE', 'NOTICE', 'VENDORED.md'],
        },
        null,
        2,
      ),
    )
    await notices(directory, stage)
    tarballs.push(await pack(stage, root, env))
  }
  // Bundle the author facade and registration bridge, including the lazily loaded
  // full Host fixture. Embed the same reviewed runtime assets as the CLI bundle.
  const host = join(root, 'packages', 'host-testkit')
  await mkdir(host, { recursive: true })
  const registryDependencies = new Map<string, string>()
  for (const { manifest } of packages.values()) {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!packages.has(name)) registryDependencies.set(name, version)
    }
  }
  const { build } = createRequire(join(repo, 'packages/cli/package.json'))('esbuild')
  const result = await build({
    entryPoints: {
      'plugin-registration': join(repo, 'packages/host/testkit/plugin-registration.ts'),
      'author-testkit': join(repo, 'packages/host/testkit/author/index.ts'),
    },
    outdir: host,
    splitting: true,
    define: {
      AGNES_BASE_EXTENSION_MANIFESTS: JSON.stringify(await extensionManifests(join(repo, 'packages/base'))),
      AGNES_CODE_EXTENSION_MANIFESTS: JSON.stringify(await extensionManifests(join(repo, 'packages/code'))),
      AGNES_PROFILE_TEMPLATE_TEXTS: JSON.stringify(
        Object.fromEntries(
          await Promise.all(
            ['local-dev', 'enterprise'].map(async (name) => [
              name,
              await readFile(join(repo, 'packages/host-common/templates', `${name}.yaml`), 'utf8'),
            ]),
          ),
        ),
      ),
      AGNES_BASE_PRESET_TEXT: JSON.stringify(
        await readFile(join(repo, 'packages/base/presets/base.yaml'), 'utf8'),
      ),
      AGNES_CC_HOOK_MAP_TEXT: JSON.stringify(
        await readFile(
          join(repo, 'packages/base/extensions/hooks-runner/generated/cc-hook-map.json'),
          'utf8',
        ),
      ),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: [...needed, ...registryDependencies.keys()].flatMap((name) => [name, `${name}/*`]),
    metafile: true,
  })
  // The image tool loads sharp through createRequire, outside esbuild's import metadata.
  const sharpVersion = registryDependencies.get('sharp')
  if (!sharpVersion) throw new Error('Host test bridge requires the declared image decoder dependency')
  const dependencies: Record<string, string> = { sharp: sharpVersion }
  const bundledOutputs = new Set(Object.keys(result.metafile.outputs).map((path) => resolve(path)))
  for (const output of Object.values(result.metafile.outputs) as { imports: { path: string }[] }[]) {
    for (const item of output.imports) {
      if (isBuiltin(item.path) || bundledOutputs.has(resolve(item.path))) continue
      const name = item.path.startsWith('@')
        ? item.path.split('/').slice(0, 2).join('/')
        : item.path.split('/')[0]!
      const version = needed.has(name) ? packages.get(name)!.manifest.version : registryDependencies.get(name)
      if (!version) throw new Error(`Host test bridge requires an unpacked dependency: ${name}`)
      dependencies[name] = version
    }
  }
  await writeFile(
    join(host, 'package.json'),
    JSON.stringify(
      {
        name: '@agnes/host',
        version: packages.get('@agnes/host')!.manifest.version,
        type: 'module',
        exports: {
          './author-testkit': './author-testkit.js',
          './testkit': './plugin-registration.js',
          './testkit/plugin-registration': './plugin-registration.js',
        },
        dependencies,
        license: packages.get('@agnes/host')!.manifest.license,
      },
      null,
      2,
    ),
  )
  await notices(join(repo, 'packages/host'), host)
  tarballs.push(await pack(host, root, env))
  return tarballs
}

export async function externalExamples(
  options: { authorOnly?: boolean; keep?: boolean; examples?: readonly string[] } = {},
): Promise<void> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'agh-external-examples-'))
  if (inside(repo, root)) throw new Error('Examples must run outside the repository')
  console.log(`External author verification: ${root}`)
  try {
    const home = join(root, 'pack-home')
    await mkdir(home)
    const tarballs = await packAuthors(root, environment(home))
    if (!options.authorOnly) {
      const { stage } = await packNpxPackage(join(root, 'harness'))
      tarballs.push(await pack(stage, root, environment(home)))
    }
    const examplesRoot = join(repo, 'examples/community')
    const sources = options.examples?.length
      ? options.examples.map((path) => resolve(repo, path))
      : (await readdir(examplesRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(examplesRoot, entry.name))
    for (const source of sources) {
      if (!inside(join(repo, 'examples'), await realpath(source)))
        throw new Error('External example must be inside examples/')
      const name = relative(join(repo, 'examples'), source).split(sep).join('-')
      await validateExample(source)
      const directory = join(root, 'examples', name)
      await cp(source, directory, {
        recursive: true,
        filter: (path) =>
          !['node_modules', 'dist'].includes(path.split(sep).at(-1)!) &&
          !path.endsWith('.tsbuildinfo') &&
          !path.endsWith('package-lock.json'),
      })
      const exampleHome = join(root, 'homes', name)
      await mkdir(exampleHome, { recursive: true })
      const env = environment(exampleHome)
      run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], directory, env)
      for (const name of ['@agnes/extension-api', '@agnes/plugin-runtime']) {
        const installed = await realpath(join(directory, 'node_modules', name))
        if (!inside(directory, installed))
          throw new Error(`Workspace dependency leaked into ${name}: ${installed}`)
      }
      run('npm', ['run', 'build'], directory, env)
      run('npm', ['test'], directory, env)
      if (!options.authorOnly)
        run(
          process.execPath,
          [join(directory, 'node_modules/@agnes/harness/bin/agh'), '--version'],
          directory,
          env,
        )
      console.log(
        `PASS ${name}: external install, build, own tests${options.authorOnly ? ' (harness packing skipped)' : ''}`,
      )
    }
  } finally {
    if (options.keep) console.log(`Kept external artifacts: ${root}`)
    else await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const examples: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--example' && args[i + 1] && !args[i + 1]!.startsWith('--')) examples.push(args[++i]!)
    else if (!['--author-only', '--keep'].includes(args[i]!))
      throw new Error('Usage: external-examples.ts [--author-only] [--keep] [--example examples/PATH]')
  }
  await externalExamples({
    authorOnly: args.includes('--author-only'),
    keep: args.includes('--keep'),
    examples,
  })
}
