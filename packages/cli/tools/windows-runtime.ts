import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Own temporary compiler outputs until the caller has finished assembling its distribution. */
export async function withBuiltSystemRuntime(
  packages: string,
  consume: (nativeOutput: string) => Promise<void>,
): Promise<void> {
  const nativeOutput = await mkdtemp(join(tmpdir(), 'agnes-local-native-'))
  try {
    buildSystemRuntime(packages, nativeOutput)
    await consume(nativeOutput)
  } finally {
    await rm(nativeOutput, { recursive: true, force: true })
  }
}

/** Build against the Node runtime that will run the local distribution, before replacing old output. */
export function buildSystemRuntime(packages: string, nativeOutput?: string): void {
  execFileSync(
    process.execPath,
    [
      join(packages, 'system-node', 'scripts', 'build-native.mjs'),
      ...(nativeOutput ? ['--output-dir', nativeOutput] : []),
    ],
    {
      stdio: 'inherit',
      windowsHide: true,
    },
  )
}

/** Preserve Node's package resolution for createRequire from bundled entries on every platform. */
export async function copySystemRuntime(
  packages: string,
  output: string,
  nativeOutput?: string,
): Promise<void> {
  const source = join(packages, 'system-node')
  const target = join(output, 'node_modules', '@agnes', 'system-node')
  const windows = process.platform === 'win32' // guards-allow-platform: build-time Windows broker selection.
  await mkdir(join(target, 'dist', 'native'), { recursive: true })
  if (windows) await mkdir(join(target, 'runtime'), { recursive: true })
  await Promise.all([
    copyFile(
      join(nativeOutput ?? join(source, 'dist', 'native'), 'agnes-system.node'),
      join(target, 'dist', 'native', 'agnes-system.node'),
    ),
    ...(windows
      ? ['runtime/process-broker.mjs', 'runtime/windows-command.mjs'].map((file) =>
          copyFile(join(source, file), join(target, file)),
        )
      : []),
    writeFile(
      join(target, 'package.json'),
      `${JSON.stringify(
        {
          name: '@agnes/system-node',
          version: '0.0.0',
          private: true,
          type: 'module',
          exports: {
            './native': './dist/native/agnes-system.node',
            ...(windows ? { './process-broker': './runtime/process-broker.mjs' } : {}),
          },
        },
        null,
        2,
      )}\n`,
    ),
  ])
}

// Compatibility exports for existing Windows packaging callers and focused tests.
export const withBuiltWindowsRuntime = withBuiltSystemRuntime
export const buildWindowsRuntime = buildSystemRuntime
export const copyWindowsRuntime = copySystemRuntime
