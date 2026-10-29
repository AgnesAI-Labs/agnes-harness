/** Schema id of a `ToolResult.structured` payload that lists the workspace paths a tool found and showed; every other `structured` payload belongs to its tool. */
export const TOOL_PATH_REFERENCES = 'agh.path-references/1'

/** One path a tool showed; `path` is relative to the session's `workspaceRoot` and `/`-separated. */
export interface ToolPathReference {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
  readonly path: string
}

/** The workspace paths a tool found and showed; `total` counts every path found, including those left out of `references`. */
export interface ToolPathReferences {
  readonly schema: typeof TOOL_PATH_REFERENCES
  readonly references: readonly ToolPathReference[]
  readonly total: number
  readonly truncated: boolean
}
