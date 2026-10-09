export const isResourceControlMethod = (method: string): boolean =>
  method.startsWith('_agnes/v1/resources.') ||
  method.startsWith('_agnes/v1/skills.') ||
  method.startsWith('_agnes/v1/mcp.servers.')
