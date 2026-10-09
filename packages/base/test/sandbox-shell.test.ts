import { expect, it } from 'vitest'
import { expandShell } from '../src/sandbox-shell.js'

it('expands each dialect while preserving the complete command as one argument', () => {
  const command = `printf '%s' 'a b;中文'\nprintf done`
  expect(expandShell(['$SHELL', command], 'posix')).toEqual(['sh', '-c', command])
  expect(expandShell(['$SHELL', command], 'powershell')).toEqual(['pwsh', '-NoProfile', '-Command', command])
})
it('returns an independent copy for ordinary argv without interpreting metacharacters', () => {
  const argv = ['echo', 'a b', ';', '']
  const result = expandShell(argv, 'posix')
  expect(result).toEqual(argv)
  result[0] = 'changed'
  expect(argv[0]).toBe('echo')
})
it.each(
  [[], [''], ['$SHELL'], ['$SHELL', ''], ['$SHELL', 'echo x', 'ignored'], ['echo', 'bad\0arg']].map(
    (argv) => ({ argv }),
  ),
)('refuses malformed argv without echoing it: $argv', ({ argv }) => {
  expect(() => expandShell(argv, 'posix')).toThrow(/^invalid sandbox (shell )?command$/)
})
