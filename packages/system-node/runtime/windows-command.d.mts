export type WindowsCommandPathIo = Readonly<{
  path?: Pick<
    typeof import('node:path').win32,
    'delimiter' | 'extname' | 'isAbsolute' | 'join' | 'resolve' | 'relative'
  >
  isFile?: (candidate: string) => boolean
}>
export function resolveWindowsCommand(
  command: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  io?: WindowsCommandPathIo,
): string | undefined
export function windowsCommand(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  mode?: 'script' | 'argv-proxy',
): { argv: string[]; verbatim: boolean }
