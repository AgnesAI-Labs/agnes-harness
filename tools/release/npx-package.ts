/**
 * Public npm identity for the one-line install.
 *
 * The workspace package stays `@agnes/cli` (private, 0.0.0) so repository builds and
 * filters keep working. `npm pack` emits `@agnes/harness` with no install-time dependencies.
 * The version scheme is `0.1.0-alpha.N`. This candidate is `0.1.0-alpha.0` and is not published.
 */
export const PUBLIC_PACKAGE_NAME = '@agnes/harness'
export const PUBLIC_BIN = 'agh'
export const PUBLIC_PACKAGE_VERSION = '0.1.0-alpha.0'
export const PUBLIC_NODE_RANGE = '>=24.10'

/** Platforms a release tarball may contain. Each pack includes the host triple it was built on. */
export const SUPPORTED_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
] as const

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number]

export type PublishableManifest = {
  name: typeof PUBLIC_PACKAGE_NAME
  version: typeof PUBLIC_PACKAGE_VERSION
  description: string
  type: 'module'
  bin: { agh: './bin/agh' }
  exports: { './package.json': './package.json' }
  files: string[]
  engines: { node: typeof PUBLIC_NODE_RANGE }
  os: string[]
  cpu: string[]
  license: 'Apache-2.0'
  publishConfig: { access: 'public' }
  repository: { type: 'git'; url: string; directory: string }
}

export function publishableManifest(triple: string): PublishableManifest {
  if (!isSupportedPlatform(triple)) throw new Error(`Unsupported prebuild triple ${triple}`)
  const [os, cpu] = triple.split('-')
  if (os === undefined || cpu === undefined) throw new Error(`Unsupported prebuild triple ${triple}`)
  return {
    name: PUBLIC_PACKAGE_NAME,
    version: PUBLIC_PACKAGE_VERSION,
    description: 'Agnes Harness local runtime (release candidate).',
    type: 'module',
    bin: { [PUBLIC_BIN]: './bin/agh' },
    exports: { './package.json': './package.json' },
    files: ['bin', 'dist', 'LICENSE', 'NOTICE'],
    engines: { node: PUBLIC_NODE_RANGE },
    os: [os],
    cpu: [cpu],
    license: 'Apache-2.0',
    publishConfig: { access: 'public' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/AgnesAI-Labs/agnes-harness.git',
      directory: 'packages/cli',
    },
  }
}

export function isSupportedPlatform(triple: string): triple is SupportedPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(triple)
}
