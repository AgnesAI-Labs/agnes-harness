/** Browser platform singletons supplied by the Host import map, never bundled into a plugin. */
export const CLIENT_PLATFORM_IMPORTS = [
  'react',
  'react/jsx-runtime',
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
