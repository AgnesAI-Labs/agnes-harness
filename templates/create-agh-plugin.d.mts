export const templateNames: readonly string[]
export function scaffold(
  template: string,
  name: string,
  destination?: string,
  options?: { local?: boolean },
): Promise<string>
