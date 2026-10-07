#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_PACKAGE_VERSION, publishableManifest } from './npx-package.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..')

export async function packNpxPackage(stage: string): Promise<{ stage: string; triple: string }> {
  const triple = `${process.platform}-${process.arch}` // guards-allow-platform: select the native triple produced by this release machine
  const dist = join(stage, 'dist')
  await mkdir(stage, { recursive: true })
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      join(repo, 'packages/cli/tools/build-local.ts'),
      '--output-dir',
      dist,
      '--version',
      PUBLIC_PACKAGE_VERSION,
    ],
    { stdio: 'inherit', cwd: repo },
  )
  await publishNativeLayout(dist, triple)
  await mkdir(join(stage, 'bin'), { recursive: true })
  const bin = join(stage, 'bin', 'agh')
  await copyFile(join(repo, 'packages/cli/bin/agh'), bin)
  await chmod(bin, 0o755)
  await copyFile(join(repo, 'LICENSE'), join(stage, 'LICENSE'))
  await copyFile(join(repo, 'NOTICE'), join(stage, 'NOTICE'))
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(publishableManifest(triple), null, 2)}\n`)
  await writeFile(join(stage, 'README.md'), readme(triple))
  // A package staged inside this repo must not inherit the root gitignore, which excludes dist/.
  await writeFile(join(stage, '.npmignore'), '*.log\n')
  return { stage, triple }
}

async function publishNativeLayout(dist: string, triple: string): Promise<void> {
  const system = join(dist, 'node_modules', '@agnes', 'system-node')
  const native = join(system, 'dist', 'native', 'agnes-system.node')
  if (!existsSync(native)) throw new Error(`native addon missing at ${native}`)
  const packed = join(dist, 'prebuilds', triple)
  await mkdir(packed, { recursive: true })
  await copyFile(native, join(packed, 'agnes-system.node'))
  for (const name of ['macos-process-identity', 'macos-live-app-identity']) {
    const source = join(dist, 'native', name)
    if (!existsSync(source)) continue
    await copyFile(source, join(packed, name))
    await chmod(join(packed, name), 0o755)
  }
  for (const name of ['process-broker.mjs', 'windows-command.mjs']) {
    const source = join(system, 'runtime', name)
    if (!existsSync(source)) continue
    await mkdir(join(packed, 'runtime'), { recursive: true })
    await copyFile(source, join(packed, 'runtime', name))
  }
  await writeFile(
    join(dist, 'prebuilds', 'index.json'),
    `${JSON.stringify({ triples: [triple], node: '>=24.10' }, null, 2)}\n`,
  )
  await rename(join(dist, 'node_modules'), join(dist, 'vendor'))
}

function readme(triple: string): string {
  return [
    '# @agnes/harness',
    '',
    'Release candidate. This package is not published to the npm registry yet.',
    '',
    '- Command: `agh`',
    `- Version scheme: \`0.1.0-alpha.N\` (this tarball is \`${PUBLIC_PACKAGE_VERSION}\`)`,
    '- Node.js: `>=24.10`',
    `- Native prebuild in this tarball: \`${triple}\``,
    '- Intended platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64',
    '',
    '`agh web` and `agh start` start the local daemon, worker, and Web workbench.',
    '',
  ].join('\n')
}

function stageFromArgs(args: readonly string[]): string {
  if (args.length === 0) return join(repo, 'packages/cli/dist/npx-package')
  if (args.length === 2 && args[0] === '--stage' && args[1] !== undefined && isAbsolute(args[1]))
    return args[1]
  throw new Error('Expected no arguments, or --stage with an absolute directory')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = stageFromArgs(process.argv.slice(2))
  const packed = await packNpxPackage(stage)
  process.stdout.write(`packed ${packed.triple} at ${packed.stage}\n`)
}
