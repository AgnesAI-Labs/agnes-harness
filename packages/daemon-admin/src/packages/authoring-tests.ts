import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runIsolatedCommand } from '@agnes/package-isolation'
import type { AuthoringTestRunner } from '@agnes/package-manager'
import { providedExternalModules } from '@agnes/plugin-runtime/provided-externals'
import type { build as Build } from 'esbuild'

/** Host-run Node tests, never caller-supplied success claims or Markdown-as-shell. */
export const runAuthoringTests: AuthoringTestRunner = async (directory, files, signal) => {
  directory = realpathSync(directory)
  const tests = files.filter((f) => /\.test\.(mjs|js|ts)$/.test(f.path))
  if (!tests.length)
    return {
      state: 'failed',
      count: 0,
      runner: 'node-test',
      output: 'Add at least one observable Node test before review.',
    }
  const require = createRequire(import.meta.url)
  const sdk = join(dirname(fileURLToPath(import.meta.url)), 'authoring-sdk.mjs')
  const output = join(directory, 'node_modules', '.authoring-tests')
  mkdirSync(output, { recursive: true })
  const modules: Record<string, readonly string[]> = {
    ...Object.fromEntries(
      Object.entries(providedExternalModules).map(([name, values]) => [name, Object.keys(values)]),
    ),
    '@agnes/plugin-runtime/testkit': [],
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
            b.onResolve({ filter: /^(?:@agnes\/|@sinclair\/typebox)/ }, (args) => {
              if (!args.importer.startsWith(directory + '/')) return undefined
              if (!Object.hasOwn(modules, args.path))
                throw new Error('Only public author SDK modules are available in candidate tests')
              return existsSync(sdk)
                ? { path: args.path, namespace: 'authoring-sdk' }
                : { path: require.resolve(args.path) }
            })
            b.onResolve({ filter: /.*/, namespace: 'authoring-sdk' }, () => ({
              path: pathToFileURL(sdk).href,
              external: true,
            }))
            b.onLoad({ filter: /.*/, namespace: 'authoring-sdk' }, (args) => ({
              loader: 'js',
              contents: `import { namespaces } from ${JSON.stringify(sdk)};\n${(modules[args.path] ?? [])
                .filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) && k !== 'default')
                .map(
                  (k) =>
                    `export const ${k} = namespaces[${JSON.stringify(args.path)}][${JSON.stringify(k)}];`,
                )
                .join('\n')}`,
            }))
            // Resolve the testkit's optional Host peer through its own public export.
            // Bundling variable imports cannot otherwise carry the production registration bridge.
            b.onLoad({ filter: /[/\\]plugin-runtime[/\\]testkit[/\\]plugin\.ts$/ }, (args) => ({
              loader: 'ts',
              contents: readFileSync(args.path, 'utf8').replace(
                'import(hostTestkit)',
                `import(${JSON.stringify(createRequire(args.path).resolve('@agnes/host/testkit/plugin-registration'))})`,
              ),
            }))
            // Preserve source-relative asset URLs when a plugin is bundled into a test entry.
            b.onLoad({ filter: /\.(ts|mjs|js)$/ }, async (args) => {
              if (!args.path.startsWith(directory + '/')) return undefined
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
    const result = await runIsolatedCommand(
      'node',
      [
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
          PATH: process.env.PATH,
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
      output: result.stdout.slice(-16384),
    }
  } catch (error) {
    if (signal.aborted) throw error
    return {
      state: 'failed',
      count: 0,
      runner: 'node-test',
      output: 'Candidate test command or compilation failed; no passing result recorded.',
    }
  }
}
