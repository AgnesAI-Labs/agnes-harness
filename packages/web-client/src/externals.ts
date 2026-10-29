/**
 * Shared platform singletons: plugin builds must externalize these specifiers; the host import map supplies one instance.
 * The official `@agnes/web` build checks dependency graphs against this table: never inline shared platform modules into plugin chunks.
 */
export const externals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@agnes/cordis',
  '@agnes/web-client',
  '@agnes/web-ui',
  '@agnes/protocol',
  '@agnes/sdk/browser',
  '@agnes/sdk',
  '@agnes/web-units/shell',
  '@agnes/web-foundation/locale-catalog',
  '@agnes/web-conversation/goal-renderers',
  '@agnes/web-conversation/interaction-renderer',
  '@agnes/web/presentation-renderers',
] as const

export type ExternalSpecifier = (typeof externals)[number]

/** Plugin builder contract version, carried by asset manifests and build declarations for installation checks. */
export const BUILDER_VERSION = 1
