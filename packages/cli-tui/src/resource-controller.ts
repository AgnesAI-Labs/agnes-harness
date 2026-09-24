/** TUI's local injection port. Bootstrap supplies an implementation without importing command parsing. */
export type ResourceCommandKind = 'resources' | 'skills' | 'mcp'
export type TuiResourceController = Readonly<{
  execute(
    kind: ResourceCommandKind,
    profile: string,
    args: readonly string[],
  ): Promise<Readonly<{ text: string; unsupported?: boolean }>>
}>
