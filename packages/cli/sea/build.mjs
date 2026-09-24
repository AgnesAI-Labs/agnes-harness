import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import postject from 'postject'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist', 'sea')
const target = `${process.platform}-${process.arch}`
const executable = join(out, `agnes-${target}${process.platform === 'win32' ? '.exe' : ''}`)
const harness = join(out, `sea-loader-smoke-${target}${process.platform === 'win32' ? '.exe' : ''}`)
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const seaNode = process.env.AGNES_SEA_NODE || process.execPath
const workspace = join(root, '..')
const seaRuntime = JSON.parse(
  execFileSync(
    seaNode,
    ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'],
    { windowsHide: true },
  ).toString(),
)
if (
  !String(seaRuntime.version).startsWith('24.') ||
  seaRuntime.platform !== process.platform ||
  seaRuntime.arch !== process.arch
)
  throw new Error(
    `AGNES_SEA_NODE must be Node 24 for ${target}; got ${seaRuntime.version} ${seaRuntime.platform}-${seaRuntime.arch}`,
  )

const textMap = (dir, extension) =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((file) => extname(file) === `.${extension}`)
      .sort()
      .map((file) => [basename(file, `.${extension}`), readFileSync(join(dir, file), 'utf8')]),
  )
const profileTemplates = textMap(join(workspace, 'host', 'templates'), 'yaml')
const codePresets = textMap(join(workspace, 'code', 'presets'), 'yaml')
const codePrompts = textMap(join(workspace, 'code', 'prompts'), 'md')
const conformanceFixtures = textMap(join(workspace, 'ai', 'fixtures', 'conformance'), 'jsonl')
const hookMap = readFileSync(
  join(workspace, 'base', 'extensions', 'hooks-runner', 'generated', 'cc-hook-map.json'),
  'utf8',
)
const extensionManifests = (packageDirectory) => {
  const pkg = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
  return (pkg.agnes?.extensions ?? []).map((relative) =>
    JSON.parse(readFileSync(join(packageDirectory, relative, 'agnes.extension.json'), 'utf8')),
  )
}
const baseExtensionManifests = extensionManifests(join(workspace, 'base'))
const codeExtensionManifests = extensionManifests(join(workspace, 'code'))

const bundleJitiTransform = {
  name: 'bundle-jiti-transform',
  setup(build) {
    build.onLoad({ filter: /[\\/]jiti[\\/]lib[\\/]jiti\.mjs$/ }, ({ path }) => {
      const dist = join(dirname(path), '..', 'dist')
      return {
        loader: 'js',
        contents: `
          import { createRequire } from 'node:module'
          import create from ${JSON.stringify(join(dist, 'jiti.cjs'))}
          import transform from ${JSON.stringify(join(dist, 'babel.cjs'))}
          const nativeImport = (id) => import(id)
          const onError = (error) => { throw error }
          export function createJiti(id, opts = {}) {
            return create(id, { ...opts, transform: opts.transform || transform },
              { onError, nativeImport, createRequire })
          }
          export default createJiti
        `,
      }
    })
  },
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

async function buildSea(name, entry, destination) {
  const bundle = join(out, `${name}.cjs`)
  const blob = join(out, `${name}.blob`)
  await build({
    entryPoints: [join(root, 'sea', entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: bundle,
    plugins: [bundleJitiTransform],
    define: {
      AGNES_VERSION: JSON.stringify(String(version)),
      AGNES_PACKAGED_BUILTINS: 'true',
      AGNES_COMPOSED_WORKER: 'true',
      AGNES_BASE_PRESET_TEXT: JSON.stringify(
        readFileSync(join(workspace, 'base', 'presets', 'base.yaml'), 'utf8'),
      ),
      AGNES_CC_HOOK_MAP_TEXT: JSON.stringify(hookMap),
      AGNES_PROFILE_TEMPLATE_TEXTS: JSON.stringify(profileTemplates),
      AGNES_CODE_PRESET_TEXTS: JSON.stringify(codePresets),
      AGNES_CODE_MINIMAL_SHA256: JSON.stringify(
        readFileSync(join(workspace, 'code', 'presets', 'minimal-rl.sha256'), 'utf8').trim(),
      ),
      AGNES_CODE_PROMPT_TEXTS: JSON.stringify(codePrompts),
      AGNES_CONFORMANCE_FIXTURE_TEXTS: JSON.stringify(conformanceFixtures),
      AGNES_BASE_EXTENSION_MANIFESTS: JSON.stringify(baseExtensionManifests),
      AGNES_CODE_EXTENSION_MANIFESTS: JSON.stringify(codeExtensionManifests),
      'import.meta.url': '__seaImportMetaUrl',
      'import.meta.resolve': '__seaResolve',
    },
    banner: {
      js: "const __seaImportMetaUrl = require('node:url').pathToFileURL(process.execPath).href; const __seaResolve = require.resolve;",
    },
  })
  const config = join(out, `${name}-config.json`)
  writeFileSync(
    config,
    JSON.stringify(
      {
        main: basename(bundle),
        output: basename(blob),
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
      },
      null,
      2,
    ),
  )
  execFileSync(seaNode, ['--experimental-sea-config', basename(config)], {
    cwd: out,
    stdio: 'inherit',
    windowsHide: true,
  })
  copyFileSync(seaNode, destination)
  if (process.platform === 'darwin')
    execFileSync('codesign', ['--remove-signature', destination], { stdio: 'ignore' })
  await postject.inject(destination, 'NODE_SEA_BLOB', readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
  })
  if (process.platform !== 'win32') chmodSync(destination, 0o755)
  if (process.platform === 'darwin')
    execFileSync('codesign', ['--sign', '-', destination], { stdio: 'inherit' })
  rmSync(bundle)
  rmSync(blob)
  rmSync(config)
}

// Shared mode launches separate daemon/worker processes. Package the same built entries and a
// verified Node runtime; the SEA CLI must never execute itself as if it were a Node interpreter.
execFileSync(
  process.platform === 'win32' ? seaNode : process.execPath,
  ['--import', 'tsx', join(root, 'tools', 'build-local.ts')],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  },
)
const local = join(root, 'dist', 'local')
for (const name of ['daemon.mjs', 'worker.mjs', 'web', 'THIRD-PARTY-NOTICES', 'bundled-plugins'])
  cpSync(join(local, name), join(out, name), { recursive: true })
if (existsSync(join(local, 'native'))) cpSync(join(local, 'native'), join(out, 'native'), { recursive: true })
cpSync(
  join(local, 'node_modules', '@agnes', 'system-node'),
  join(out, 'node_modules', '@agnes', 'system-node'),
  { recursive: true },
)
const runtime = join(out, 'runtime')
mkdirSync(runtime, { recursive: true })
const runtimeNode = join(runtime, process.platform === 'win32' ? 'node.exe' : 'node')
copyFileSync(seaNode, runtimeNode)
if (process.platform !== 'win32') chmodSync(runtimeNode, 0o755)

await buildSea('agnes', 'entry.ts', executable)
await buildSea('sea-loader-smoke', 'loader-harness.ts', harness)
process.stdout.write(`built ${executable}\n`)
