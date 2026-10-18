import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { collectPackageSkillFiles, discoverPackageSkill, packageSkillLoadError } from '@agnes/base'
import { bindProvidedContractModules } from '@agnes/base/provided-contracts'
import { safeAuthoringOutput } from '@agnes/error-sanitization'
import type { AuthoringTestRunner } from '@agnes/package-manager'
import { providedExternalModules } from '@agnes/plugin-runtime/provided-externals'
import type { build as Build } from 'esbuild'
import {
  type AuthoringSandboxContext,
  authoringSandbox,
  defaultAuthoringSandboxContext,
} from './authoring-sandbox.js'

/** Host-run Node tests, never caller-supplied success claims or Markdown-as-shell. */
async function testCandidate(
  directory: string,
  files: Parameters<AuthoringTestRunner>[1],
  signal: AbortSignal,
  context: AuthoringSandboxContext,
): ReturnType<AuthoringTestRunner> {
  directory = realpathSync(directory)
  const insideCandidate = (path: string): boolean => {
    if (!path) return false
    const rel = relative(directory, path)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }
  // The Host validates document semantics with the same parser used by the worker. Author-written
  // tests cannot claim that a malformed static Skill is ready for review.
  try {
    const manifest = JSON.parse(files.find((file) => file.path === 'package.json')?.content ?? '{}')
    for (const contribution of manifest.agnes?.contributions ?? []) {
      if (contribution.kind !== 'skill') continue
      const source = files.find((file) => `./${file.path}` === contribution.path)?.content
      if (
        source === undefined ||
        !discoverPackageSkill({
          packageId: manifest.name,
          contributionId: contribution.id,
          relativeLocation: contribution.path,
          source,
        })
      )
        throw new Error('invalid static Skill')
      const document = realpathSync(join(directory, contribution.path))
      if (!insideCandidate(document)) throw new Error('invalid static Skill path')
      signal.throwIfAborted()
      await collectPackageSkillFiles(dirname(document), source)
    }
  } catch (error) {
    signal.throwIfAborted()
    const code = (error as { code?: unknown })?.code
    return {
      state: 'failed',
      count: 0,
      runner: 'node-test',
      output:
        typeof code === 'string' && code.startsWith('SKILL_')
          ? `${packageSkillLoadError(code).message} Fix the Skill before submitting for review.`
          : 'Static Skill metadata or body is invalid. Fix its SKILL.md before submitting for review.',
    }
  }
  const tests = files.filter((f) => /\.test\.(mjs|js|ts)$/.test(f.path))
  if (!tests.length)
    return {
      state: 'failed',
      count: 0,
      runner: 'node-test',
      output: 'Add at least one observable Node test before review.',
    }
  bindProvidedContractModules()
  const require = createRequire(import.meta.url)
  const sdk = join(dirname(fileURLToPath(import.meta.url)), 'authoring-sdk.mjs')
  const sdkRequire = existsSync(sdk) ? require : createRequire(require.resolve('@agnes/host/author-testkit'))
  const output = join(directory, 'node_modules', '.authoring-tests')
  mkdirSync(output, { recursive: true })
  const modules: Record<string, readonly string[]> = {
    ...Object.fromEntries(
      Object.entries(providedExternalModules).map(([name, values]) => [name, Object.keys(values)]),
    ),
    '@agnes/plugin-runtime/testkit': [],
    '@agnes/host/testkit': ['createPluginTestRegistration'],
    '@agnes/host/author-testkit': [],
    '@agnes/web-client/testkit': [],
    react: [],
  }
  const sdkExports = join(dirname(sdk), 'authoring-sdk-exports.json')
  if (existsSync(sdk)) {
    const names = JSON.parse(readFileSync(sdkExports, 'utf8')) as Record<string, readonly string[]>
    for (const name of Object.keys(modules)) modules[name] = names[name] ?? []
  }
  try {
    let build: typeof Build
    try {
      build = (require('esbuild') as typeof import('esbuild')).build
    } catch {
      build = (
        require(
          join(dirname(fileURLToPath(import.meta.url)), 'node_modules/esbuild'),
        ) as typeof import('esbuild')
      ).build
    }
    await build({
      entryPoints: tests.map((f) => join(directory, f.path)),
      outdir: output,
      outbase: directory,
      outExtension: { '.js': '.mjs' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      banner: {
        js: "import { createRequire as __authoringRequire } from 'node:module'; const require = __authoringRequire(import.meta.url);",
      },
      logLevel: 'silent',
      plugins: [
        {
          name: 'authoring-public-sdk',
          setup(b) {
            // Native SDK dependencies retain their own optional-package resolution. Candidate
            // imports still go through the hashed-source restriction below.
            b.onResolve({ filter: /^sharp$/ }, (args) => {
              if (insideCandidate(args.importer)) return undefined
              return {
                path: pathToFileURL(require.resolve(args.path, { paths: [args.resolveDir] })).href,
                external: true,
              }
            })
            b.onResolve({ filter: /^(?:@agnes\/|@sinclair\/typebox|react$)/ }, (args) => {
              if (!insideCandidate(args.importer)) return undefined
              if (!Object.hasOwn(modules, args.path))
                throw new Error('Only public author SDK modules are available in candidate tests')
              return existsSync(sdk)
                ? { path: args.path, namespace: 'authoring-sdk' }
                : {
                    path: (args.path === 'react'
                      ? createRequire(require.resolve('@agnes/web-client/testkit'))
                      : args.path === '@agnes/web-client/testkit'
                        ? require
                        : sdkRequire
                    ).resolve(
                      args.path === '@agnes/host/testkit'
                        ? '@agnes/host/testkit/plugin-registration'
                        : args.path,
                    ),
                  }
            })
            b.onResolve({ filter: /.*/, namespace: 'authoring-sdk' }, () => ({
              path: pathToFileURL(sdk).href,
              external: true,
            }))
            b.onLoad({ filter: /.*/, namespace: 'authoring-sdk' }, (args) => ({
              loader: 'js',
              contents: `import { namespaces } from ${JSON.stringify(sdk)};\n${(modules[args.path] ?? [])
                .filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k))
                .map((k) =>
                  k === 'default'
                    ? `export default namespaces[${JSON.stringify(args.path)}].default;`
                    : `export const ${k} = namespaces[${JSON.stringify(args.path)}][${JSON.stringify(k)}];`,
                )
                .join('\n')}`,
            }))
            // Compilation is Host work: candidate imports must not make esbuild read private
            // files before the OS boundary starts. Only the selected public SDK escapes this tree.
            b.onResolve({ filter: /.*/ }, async (args) => {
              if (!insideCandidate(args.importer) || args.pluginData?.authoringResolved) return undefined
              if (isBuiltin(args.path)) return { path: args.path, external: true }
              const resolved = await b.resolve(args.path, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: { authoringResolved: true },
              })
              if (resolved.errors.length || !insideCandidate(realpathSync(resolved.path)))
                throw new Error('Candidate imports must stay inside their source tree')
              if (!files.some((file) => join(directory, file.path) === resolved.path))
                throw new Error('Candidate import is not part of the hashed source')
              return { path: resolved.path }
            })
            // Preserve source-relative asset URLs when a plugin is bundled into a test entry.
            b.onLoad({ filter: /\.(ts|mjs|js)$/ }, async (args) => {
              if (!insideCandidate(args.path)) return undefined
              const file = files.find((f) => join(directory, f.path) === args.path)
              if (!file) return undefined
              return {
                loader: args.path.endsWith('.ts') ? 'ts' : 'js',
                contents: file.content.replaceAll(
                  'import.meta.url',
                  JSON.stringify(pathToFileURL(args.path).href),
                ),
              }
            })
          },
        },
      ],
    })
    signal.throwIfAborted()
    const { sandbox } = await authoringSandbox(context, directory, signal)
    const result = await sandbox.exec(
      [
        process.execPath,
        '--input-type=module',
        '--eval',
        `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['--test','--test-reporter=tap',...process.argv.slice(1)],{stdio:['ignore','pipe','pipe']}); child.stdout.pipe(process.stdout);child.stderr.pipe(process.stdout);child.once('error',()=>console.log('# authoring-exit spawn-failed'));child.once('close',code=>console.log('# authoring-exit '+code));`,
        ...tests.map((f) => join(output, f.path.replace(/\.(mjs|js|ts)$/, '.mjs'))),
      ],
      {
        cwd: directory,
        signal,
        timeoutMs: 60_000,
        maxOutputBytes: 16384,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: output,
          TMPDIR: output,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      },
    )
    const count = Number(/^# tests (\d+)$/m.exec(result.stdout)?.[1] ?? 0)
    const failed = Number(/^# fail (\d+)$/m.exec(result.stdout)?.[1] ?? -1)
    return {
      state:
        count > 0 &&
        Number(/^# pass (\d+)$/m.exec(result.stdout)?.[1] ?? 0) > 0 &&
        failed === 0 &&
        result.stdout.trimEnd().endsWith('# authoring-exit 0')
          ? 'passed'
          : 'failed',
      count,
      runner: 'node-test',
      output: safeAuthoringOutput(result.stdout, 16384, directory),
    }
  } catch (error) {
    if (signal.aborted) throw error
    const partial =
      error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string'
        ? error.stdout
        : ''
    return {
      state: 'failed',
      count: 0,
      runner: 'node-test',
      output: safeAuthoringOutput(
        error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors)
          ? error.errors
              .slice(0, 16)
              .map((issue) => {
                const location = issue.location
                return `CompileError: ${issue.text} (${location?.file ?? 'unknown'}:${location?.line ?? 0}:${location?.column ?? 0})`
              })
              .join('\n')
          : `${error instanceof Error ? `${error.name}: ${error.message}` : 'Candidate test command failed'}; no passing result recorded.\n${partial}`,
        16384,
        directory,
      ),
    }
  }
}

export const createAuthoringTestRunner =
  (context: AuthoringSandboxContext): AuthoringTestRunner =>
  (directory, files, signal) =>
    testCandidate(directory, files, signal, context)

export const runAuthoringTests: AuthoringTestRunner = (directory, files, signal) =>
  createAuthoringTestRunner(defaultAuthoringSandboxContext())(directory, files, signal)
