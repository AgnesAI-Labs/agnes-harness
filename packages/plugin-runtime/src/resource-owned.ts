/**
 * Row ids the resource side owns. A runtime target's `resource.rows` must name exactly these, the
 * daemon skips them when composing targets, and Host refuses a package that declares one.
 *
 * `ext:agnes/mcp-client` has no supplier any more: MCP servers became one Host row each and the
 * extension was retired (design 2026-09-21-resource-rows-design.md §3.9, D121). It stays listed on
 * purpose: removing it changes the target format that published and persisted targets carry, and
 * would let a package claim the id. Retire it only with a target format version change.
 */
export const RESOURCE_OWNED_ROW_IDS = Object.freeze(['ext:agnes/skills', 'ext:agnes/mcp-client'] as const)

export type ResourceOwnedRowId = (typeof RESOURCE_OWNED_ROW_IDS)[number]

const RESOURCE_OWNED_ROW_ID_SET: ReadonlySet<string> = new Set(RESOURCE_OWNED_ROW_IDS)

export function isResourceOwnedRowId(value: string): value is ResourceOwnedRowId {
  return RESOURCE_OWNED_ROW_ID_SET.has(value)
}
