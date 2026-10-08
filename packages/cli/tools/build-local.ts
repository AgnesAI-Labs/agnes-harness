#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, chmod, copyFile, cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_HELPERS } from '@agnes/package-manager'
import { type BuildOptions, type BuildResult, build, type Plugin } from 'esbuild'
import { collectThirdPartyNotices } from '../../../tools/third-party-notices.mjs'
import { beginRuntimeDirectory } from '../../base/tools/runtime-directory.js'
import { buildConversationCss } from '../../web-ui/tools/build-conversation-css.js'
import { prepareDocumentReader } from './document-reader.js'
import { copyPluginPackRuntime } from './plugin-pack-runtime.js'
import { copyRipgrep } from './ripgrep.js'
import { copySystemRuntime, withBuiltSystemRuntime } from './windows-runtime.js'

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoPackages = join(cliRoot, '..')
const webRoot = join(repoPackages, 'web')
const require = createRequire(import.meta.url)
const computerUseNoticeSource = join(repoPackages, 'base', 'extensions', 'computer-use', 'NOTICE')
const computerUseNoticeRelative = join('THIRD-PARTY-NOTICES', 'computer-use-hermes.txt')
const isDarwin = (): boolean => process.platform === 'darwin' // guards-allow-platform: target native

export async function copyComputerUseNotice(outputDirectory: string): Promise<void> {
  const destination = join(outputDirectory, computerUseNoticeRelative)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(computerUseNoticeSource, destination)
}

/** Copy only runtime payload, never repository tests or personal working files. */
export async function copyBundledPlugins(outputDirectory: string): Promise<void> {
  for (const { name: helper } of BUNDLED_HELPERS) {
    const source = join(repoPackages, 'package-manager', 'bundled-plugins', helper)
    const destination = join(outputDirectory, 'bundled-plugins', helper)
    await mkdir(destination, { recursive: true })
    for (const name of ['package.json', 'index.mjs', 'src', 'README.md', 'LICENSE'])
      await cp(join(source, name), join(destination, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      })
    if (helper === 'document-reader') await prepareDocumentReader(destination)
  }
}

const bundleJitiTransform: Plugin = {
  name: 'bundle-jiti-transform',
  setup(esbuild) {
    esbuild.onLoad({ filter: /[\\/]jiti[\\/]lib[\\/]jiti\.mjs$/ }, ({ path }) => {
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

async function bundle(entry: string, outfile: string, define: Record<string, string> = {}): Promise<void> {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node24'],
    packages: 'bundle',
    sourcemap: false,
    legalComments: 'eof',
    charset: 'utf8',
    logLevel: 'warning',
    banner: {
      // The bundled ws transport still uses a small number of CommonJS dynamic requires for
      // Node builtins. Keep that trusted loader available in the regular ESM delivery build.
      js: "import { createRequire as __agnesCreateRequire } from 'node:module'; const require = __agnesCreateRequire(import.meta.url);",
    },
    plugins: [bundleJitiTransform],
    define,
  })
}

async function textMap(directory: string, extension: string): Promise<Record<string, string>> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(`.${extension}`)).sort()
  const entries = await Promise.all(
    files.map(
      async (file) =>
        [file.slice(0, -(extension.length + 1)), await readFile(join(directory, file), 'utf8')] as const,
    ),
  )
  return Object.fromEntries(entries)
}

async function extensionManifests(packageDirectory: string): Promise<readonly unknown[]> {
  const packageJson = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    agnes?: { extensions?: readonly string[] }
  }
  return Promise.all(
    (packageJson.agnes?.extensions ?? []).map(async (relative) =>
      JSON.parse(await readFile(join(packageDirectory, relative, 'agnes.extension.json'), 'utf8')),
    ),
  )
}

async function runtimeDefines(version: string): Promise<Record<string, string>> {
  const base = join(repoPackages, 'base')
  const code = join(repoPackages, 'code')
  const ai = join(repoPackages, 'ai')
  const [
    profileTemplates,
    codePresets,
    codePrompts,
    conformanceFixtures,
    hookMap,
    baseExtensions,
    codeExtensions,
    minimalSha,
  ] = await Promise.all([
    textMap(join(repoPackages, 'host-common', 'templates'), 'yaml'),
    textMap(join(code, 'presets'), 'yaml'),
    textMap(join(code, 'prompts'), 'md'),
    textMap(join(ai, 'fixtures', 'conformance'), 'jsonl'),
    readFile(join(base, 'extensions', 'hooks-runner', 'generated', 'cc-hook-map.json'), 'utf8'),
    extensionManifests(base),
    extensionManifests(code),
    readFile(join(code, 'presets', 'minimal-rl.sha256'), 'utf8'),
  ])
  return {
    AGNES_VERSION: JSON.stringify(version),
    AGNES_BUNDLED_RIPGREP_PATH: JSON.stringify(`./ripgrep/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`), // guards-allow-platform: target native executable
    AGNES_COMPOSED_WORKER: 'true',
    AGNES_PACKAGED_BUILTINS: 'true',
    AGNES_BASE_PRESET_TEXT: JSON.stringify(await readFile(join(base, 'presets', 'base.yaml'), 'utf8')),
    AGNES_CC_HOOK_MAP_TEXT: JSON.stringify(hookMap),
    AGNES_PROFILE_TEMPLATE_TEXTS: JSON.stringify(profileTemplates),
    AGNES_CODE_PRESET_TEXTS: JSON.stringify(codePresets),
    AGNES_CODE_MINIMAL_SHA256: JSON.stringify(minimalSha.trim()),
    AGNES_CODE_PROMPT_TEXTS: JSON.stringify(codePrompts),
    AGNES_CONFORMANCE_FIXTURE_TEXTS: JSON.stringify(conformanceFixtures),
    AGNES_BASE_EXTENSION_MANIFESTS: JSON.stringify(baseExtensions),
    AGNES_CODE_EXTENSION_MANIFESTS: JSON.stringify(codeExtensions),
  }
}

export async function buildLocalWeb(webOut: string): Promise<void> {
  const metafiles: BuildResult[] = []
  const buildWithMetadata = async (options: BuildOptions): Promise<void> => {
    metafiles.push(await build({ ...options, absWorkingDir: webRoot, metafile: true }))
  }
  // Plugin entrypoints resolve these imports through index.html's import map, so the host bundle
  // must leave them external and serve exactly one shared platform instance.
  const platformExternals = [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@agnes/cordis',
    '@agnes/web-client',
    '@agnes/web-ui/assistant-ui',
    'antd',
  ]
  await buildWithMetadata({
    entryPoints: {
      app: join(repoPackages, 'web', 'src', 'app.ts'),
      admin: join(repoPackages, 'web', 'src', 'admin', 'plugins', 'admin.tsx'),
      resources: join(repoPackages, 'resource-control-web', 'src', 'admin.tsx'),
      // 独立页（/admin/plugins、/admin/resources）的宿主入口；设置弹窗里嵌的是上面三个模块。
      'admin-standalone': join(repoPackages, 'web', 'src', 'admin', 'plugins', 'standalone.ts'),
      'resources-standalone': join(repoPackages, 'resource-control-web', 'src', 'standalone.ts'),
    },
    outdir: webOut,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    // 与 packages/web/tools/build.ts 保持一致：动态 import() 的 admin / resources 面板必须变成
    // 按需 chunk，否则会被内联进主包（两份配置都要开，否则 dev 与本地发布行为不一致）。
    splitting: true,
    target: ['es2023'],
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
    external: platformExternals,
  })
  // Keep the local launcher's import-map targets and platform singleton graph identical to the
  // standalone Web build.
  const vendorOptions = {
    outdir: join(webOut, 'vendor'),
    outbase: join(repoPackages, 'web', 'tools', 'vendor'),
    bundle: true,
    splitting: true,
    format: 'esm' as const,
    platform: 'browser' as const,
    target: ['es2023'],
    sourcemap: false,
    legalComments: 'eof' as const,
    charset: 'utf8' as const,
    logLevel: 'warning' as const,
    entryNames: '[name]',
    chunkNames: 'chunk-[hash]',
  }
  await buildWithMetadata({
    entryPoints: {
      react: join(repoPackages, 'web', 'tools', 'vendor', 'react-entry.js'),
      'react-jsx-runtime': join(repoPackages, 'web', 'tools', 'vendor', 'react-jsx-runtime-entry.js'),
      'react-dom': join(repoPackages, 'web', 'tools', 'vendor', 'react-dom-entry.js'),
      'react-dom-client': join(repoPackages, 'web', 'tools', 'vendor', 'react-dom-client-entry.js'),
    },
    ...vendorOptions,
  })
  // UI vendors import the same React modules supplied by the first pass and the page import map.
  await buildWithMetadata({
    entryPoints: {
      antd: join(repoPackages, 'web', 'tools', 'vendor', 'antd-entry.js'),
      'assistant-ui': join(repoPackages, 'web', 'tools', 'vendor', 'assistant-ui-entry.js'),
      cordis: join(repoPackages, 'web', 'tools', 'vendor', 'cordis-entry.js'),
      'web-client': join(repoPackages, 'web', 'tools', 'vendor', 'web-client-entry.js'),
    },
    ...vendorOptions,
    external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'],
    banner: {
      js: "import * as __agnesSharedReact from 'react'; var require = (id) => { if (id === 'react') return __agnesSharedReact; throw Error('Unexpected external require: ' + id) };",
    },
  })
  // 首帧主题必须早于第一次绘制，所以这一份单独打成 IIFE 并以阻塞式 <script> 引入。
  // ESM 一律 defer，会先闪一帧浅色。CSP 是 script-src 'self' 无 unsafe-inline，内联脚本不可用。
  // 注意：本文件与 packages/web/tools/build.ts 是两份独立配置，新增 web 入口两边都要加。
  await buildWithMetadata({
    entryPoints: { theme: join(repoPackages, 'web', 'src', 'theme-boot.ts') },
    outdir: webOut,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2023'],
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
  })
  await Promise.all(
    ['index.html', 'admin.html', 'resources.html', 'style.css', 'brand-mark.png'].map((file) =>
      copyFile(join(repoPackages, 'web', 'public', file), join(webOut, file)),
    ),
  )
  const webUi = join(repoPackages, 'web-ui')
  const antdCss = require.resolve('antd/dist/antd.css', { paths: [webUi] })
  await Promise.all([
    copyFile(antdCss, join(webOut, 'antd.css')),
    copyFile(join(webUi, 'src', 'tokens.css'), join(webOut, 'tokens.css')),
  ])
  const conversationCss = await readFile(join(webUi, 'src', 'conversation', 'messages.css'), 'utf8')
  await appendFile(join(webOut, 'style.css'), `\n${conversationCss}`)
  const generatedConversationCss = join(webOut, 'conversation-tailwind.css')
  buildConversationCss(generatedConversationCss)
  await appendFile(join(webOut, 'style.css'), `\n${await readFile(generatedConversationCss, 'utf8')}`)
  await rm(generatedConversationCss)
  const markdownCss = join(webOut, 'vendor', 'assistant-ui.css')
  const [core, light, dark, overrides] = await Promise.all([
    readFile(markdownCss, 'utf8'),
    readFile(require.resolve('@ant-design/x-markdown/themes/light.css', { paths: [webUi] }), 'utf8'),
    readFile(require.resolve('@ant-design/x-markdown/themes/dark.css', { paths: [webUi] }), 'utf8'),
    readFile(join(webUi, 'src', 'conversation', 'markdown.css'), 'utf8'),
  ])
  await appendFile(join(webOut, 'style.css'), `\n${core}\n${light}\n${dark}\n${overrides}`)
  await rm(markdownCss)
  await collectThirdPartyNotices(webRoot, webOut, metafiles)
}

async function buildLocal(out: string, nativeOutput?: string, versionOverride?: string): Promise<void> {
  const webOut = join(out, 'web')
  await mkdir(join(out, 'native'), { recursive: true })
  await copyRipgrep(out)
  await copyComputerUseNotice(out)
  await copyBundledPlugins(out)
  await copyPluginPackRuntime(out)
  const packageJson = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  const version = versionOverride ?? (typeof packageJson.version === 'string' ? packageJson.version : '0.0.0')
  const defines = await runtimeDefines(version)

  // This is the normal package executable. SEA keeps its own build path and embedded-manifest
  // defines; sharing the source entry here keeps command routing and trusted loader behavior equal.
  await bundle(join(cliRoot, 'src', 'bin.ts'), join(out, 'agnes.mjs'), defines)
  await bundle(join(cliRoot, 'launch', 'daemon-entry.ts'), join(out, 'daemon.mjs'), defines)
  const workerSource = existsSync(join(cliRoot, 'launch', 'worker-entry.ts'))
    ? join(cliRoot, 'launch', 'worker-entry.ts')
    : join(repoPackages, 'daemon', 'src', 'worker', 'main.ts')
  await bundle(workerSource, join(out, 'worker.mjs'), defines)
  await copySystemRuntime(repoPackages, out, nativeOutput)
  const linux = process.platform === 'linux' // guards-allow-platform: native PTY build target
  if (isDarwin() || linux) {
    execFileSync(
      process.execPath,
      [join(repoPackages, 'host', 'scripts', 'build-native.mjs'), '--output-dir', join(out, 'native')],
      { stdio: 'inherit' },
    )
    await chmod(join(out, 'native', 'pty-relay'), 0o755)
    if (isDarwin()) {
      await chmod(join(out, 'native', 'macos-process-identity'), 0o755)
      await chmod(join(out, 'native', 'macos-live-app-identity'), 0o755)
    }
  }

  await buildLocalWeb(webOut)
}

function parseBuildArgs(args: readonly string[]): { out?: string; version?: string } {
  let out: string | undefined
  let version: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--output-dir') {
      const value = args[index + 1]
      if (value === undefined || !isAbsolute(value))
        throw new Error('Expected --output-dir with an absolute directory')
      out = value
      index += 1
      continue
    }
    if (arg === '--version') {
      const value = args[index + 1]
      if (value === undefined || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value))
        throw new Error('Expected --version with a SemVer version')
      version = value
      index += 1
      continue
    }
    throw new Error('Expected --output-dir with an absolute directory')
  }
  return { ...(out === undefined ? {} : { out }), ...(version === undefined ? {} : { version }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseBuildArgs(process.argv.slice(2))
  const out = parsed.out ?? join(cliRoot, 'dist', 'local')
  const transaction = await beginRuntimeDirectory(out)
  try {
    await withBuiltSystemRuntime(repoPackages, (native) =>
      buildLocal(transaction.staging, native, parsed.version),
    )
    await transaction.commit()
    process.stdout.write(`built local launch output at ${out}\n`)
  } finally {
    await transaction.dispose()
  }
}
