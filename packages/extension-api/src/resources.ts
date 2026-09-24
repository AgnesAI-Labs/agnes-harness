// Structural resource records have one owner; registration and authorization live in host/core.
export type { ResourceEntry } from '@agnes/protocol/gen/hooks'
export const RESOURCE_KINDS = Object.freeze(['skill', 'mcp', 'kb', 'datasource', 'model'] as const)
export type ResourceKind = (typeof RESOURCE_KINDS)[number]
