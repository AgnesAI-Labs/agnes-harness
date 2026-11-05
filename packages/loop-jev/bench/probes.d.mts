export function probeShell(options?: { platform?: string; env?: NodeJS.ProcessEnv }): string | undefined
export function runProbe(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ exit: number | null; output: string }>
