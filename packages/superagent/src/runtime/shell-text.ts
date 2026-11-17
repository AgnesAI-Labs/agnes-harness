/**
 * Prompt, skill and instruction text for the shell a session's commands run in. The texts are written for a POSIX
 * shell, as the original's are, and reach POSIX sessions unchanged, byte for byte, which keeps them aligned with the
 * original and the prompt cache intact. Windows sessions run PowerShell: there each POSIX form these texts use is
 * written as PowerShell, and a variable reference `$DSH_SUPERAGENT_…` as `$env:DSH_SUPERAGENT_…`.
 */
import { HOST_PLATFORM, isWindows } from '../infra/platform.js'

/**
 * The POSIX commands of the built-in texts, each with its PowerShell form. The `--msg-filter` program is a PowerShell
 * single-quoted string, so nothing in a trailer (a reviewer's name) is expanded before git's shell reads it.
 */
const POWERSHELL_FORMS: readonly (readonly [posix: string, powershell: string])[] = [
  [
    '`base=$(git merge-base HEAD origin/<base branch>)`',
    '`$base = git merge-base HEAD origin/<base branch>`',
  ],
  ['`old=$(git rev-parse origin/<head branch>)`', '`$old = git rev-parse origin/<head branch>`'],
  [
    '`FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter \'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"\' $base..HEAD`',
    "`$env:FILTER_BRANCH_SQUELCH_WARNING = '1'; git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer ''<trailer>''' \"$base..HEAD\"`",
  ],
  ['`git push --force-with-lease=<head branch>:$old`', '`git push "--force-with-lease=<head branch>:$old"`'],
]

/**
 * What a Windows worker is told about its shell: `gh` is a batch file there, and `cmd.exe`, which runs it, reads its
 * arguments again: it cuts one at a line break, and runs what follows a quote and `&` or `|` as a command, whatever the
 * PowerShell quoting. Text from people must never reach it as an argument.
 */
export const WINDOWS_SHELL_NOTE =
  'Commands run in Windows PowerShell, where `gh` is a batch file: cmd.exe reads its arguments again, cuts them at a line break, and runs what follows a quote and `&` or `|` as a command. So text from people (titles, bodies, comments), and any multi-line text, goes to gh in a file or on standard input, never on its command line: `--body-file <file>` or `--body-file -`, and with `gh api` `-F title=@<file>` and `-F body=@<file>`. A title you pass as an argument is your own words, without quotes, `&`, `|`, `<`, `>`, `^` or `%`.'

/** `text` as the sessions on `platform` read it; unchanged on POSIX. */
export function forShell(text: string, platform: string = HOST_PLATFORM): string {
  if (!isWindows(platform)) return text
  let shell = text
  for (const [posix, powershell] of POWERSHELL_FORMS) shell = shell.replaceAll(posix, powershell)
  return shell.replaceAll('$DSH_SUPERAGENT_', '$env:DSH_SUPERAGENT_')
}
