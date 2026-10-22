import {
  type CompletionSpec,
  completionSpec,
  SESSION_FLAGS,
  SESSION_KEY_VERBS,
  SHELLS,
  type Shell,
} from '../completion-spec.js'
import { ExitCode } from '../errors.js'

const words = (list: readonly string[]): string => list.join(' ')

function bash(s: CompletionSpec): string {
  const enumCases = Object.entries(s.enums)
    .map(([flag, values]) => `    ${flag}) COMPREPLY=($(compgen -W "${words(values)}" -- "$cur")); return ;;`)
    .join('\n')
  const subCases = Object.entries(s.subcommands)
    .map(([cmd, subs]) => `      ${cmd}) COMPREPLY=($(compgen -W "${words(subs)}" -- "$cur")) ;;`)
    .join('\n')
  return `# bash completion for agh. Load it with: eval "$(agh completion bash)"
_agh_sessions() {
  local key
  while IFS=$'\\t' read -r key _; do COMPREPLY+=("$key"); done < <(agh __complete sessions "$1" 2>/dev/null)
  # ':' is a word break in bash; drop the part of each key the word already holds.
  if [[ "$1" == *:* ]]; then
    local pre="\${1%"\${1##*:}"}" i
    for i in "\${!COMPREPLY[@]}"; do COMPREPLY[i]="\${COMPREPLY[i]#"$pre"}"; done
  fi
}
_agh() {
  local line="\${COMP_LINE:0:COMP_POINT}" cur prev n
  local -a w
  read -ra w <<< "$line"
  if [[ "$line" == *[[:space:]] ]]; then
    cur=""; n=\${#w[@]}; prev="\${w[n-1]}"
  else
    n=$((\${#w[@]} - 1)); cur="\${w[n]}"; prev="\${w[n-1]}"
  fi
  COMPREPLY=()
  case "$prev" in
${enumCases}
    ${SESSION_FLAGS.join('|')}) _agh_sessions "$cur"; return ;;
  esac
  local cmd="\${w[1]}"
  if [[ $n -eq 1 ]]; then
    if [[ "$cur" == -* ]]; then COMPREPLY=($(compgen -W "${words(s.flags)}" -- "$cur"))
    else COMPREPLY=($(compgen -W "${words(s.commands)}" -- "$cur")); fi
    return
  fi
  if [[ "$cur" == -* ]]; then COMPREPLY=($(compgen -W "${words(s.flags)}" -- "$cur")); return; fi
  if [[ $n -eq 2 ]]; then
    case "$cmd" in
      resume) _agh_sessions "$cur" ;;
${subCases}
    esac
  elif [[ $n -eq 3 && "$cmd" == sessions ]]; then
    case "$prev" in
      ${SESSION_KEY_VERBS.join('|')}) _agh_sessions "$cur" ;;
    esac
  fi
}
complete -o default -o bashdefault -F _agh agh
`
}

function zsh(s: CompletionSpec): string {
  const enumCases = Object.entries(s.enums)
    .map(([flag, values]) => `    ${flag}) compadd -- ${words(values)}; return ;;`)
    .join('\n')
  const subCases = Object.entries(s.subcommands)
    .map(([cmd, subs]) => `      ${cmd}) compadd -- ${words(subs)} ;;`)
    .join('\n')
  return `#compdef agh
# zsh completion for agh. Load it with: eval "$(agh completion zsh)"   (after compinit)
_agh_sessions() {
  local -a keys descs
  local key desc
  while IFS=$'\\t' read -r key desc; do keys+=("$key"); descs+=("$key  $desc"); done < <(agh __complete sessions "$1" 2>/dev/null)
  (( \${#keys} )) && compadd -d descs -a keys
}
_agh() {
  local cur="$words[CURRENT]" prev="$words[CURRENT-1]" cmd="$words[2]"
  local n=$((CURRENT - 1))
  case "$prev" in
${enumCases}
    ${SESSION_FLAGS.join('|')}) _agh_sessions "$cur"; return ;;
  esac
  if (( n == 1 )); then
    if [[ "$cur" == -* ]]; then compadd -- ${words(s.flags)}
    else compadd -- ${words(s.commands)}; fi
    return
  fi
  if [[ "$cur" == -* ]]; then compadd -- ${words(s.flags)}; return; fi
  if (( n == 2 )); then
    case "$cmd" in
      resume) _agh_sessions "$cur" ;;
${subCases}
      *) _files ;;
    esac
  elif (( n == 3 )) && [[ "$cmd" == sessions ]]; then
    case "$prev" in
      ${SESSION_KEY_VERBS.join('|')}) _agh_sessions "$cur" ;;
    esac
  else
    _files
  fi
}
if [[ "$funcstack[1]" == _agh ]]; then _agh "$@"; else compdef _agh agh; fi
`
}

function fish(s: CompletionSpec): string {
  const lines = [
    '# fish completion for agh. Load it with: agh completion fish | source',
    'complete -c agh -f',
    `complete -c agh -n '__fish_use_subcommand' -a '${words(s.commands)}'`,
  ]
  for (const [cmd, subs] of Object.entries(s.subcommands))
    lines.push(`complete -c agh -n '__fish_seen_subcommand_from ${cmd}' -a '${words(subs)}'`)
  lines.push(
    `complete -c agh -n '__fish_seen_subcommand_from resume' -a '(agh __complete sessions (commandline -ct) 2>/dev/null)'`,
    `complete -c agh -n '__fish_seen_subcommand_from sessions; and __fish_seen_subcommand_from ${words(SESSION_KEY_VERBS)}' -a '(agh __complete sessions (commandline -ct) 2>/dev/null)'`,
  )
  for (const flag of s.flags) {
    const name = flag.slice(2)
    if ((SESSION_FLAGS as readonly string[]).includes(flag))
      lines.push(`complete -c agh -l ${name} -x -a '(agh __complete sessions (commandline -ct) 2>/dev/null)'`)
    else if (s.enums[flag]) lines.push(`complete -c agh -l ${name} -x -a '${words(s.enums[flag])}'`)
    else if (s.valueFlags.includes(flag)) lines.push(`complete -c agh -l ${name} -r -F`)
    else lines.push(`complete -c agh -l ${name}`)
  }
  return `${lines.join('\n')}\n`
}

export function completionScript(shell: Shell, spec: CompletionSpec = completionSpec()): string {
  return shell === 'bash' ? bash(spec) : shell === 'zsh' ? zsh(spec) : fish(spec)
}

/** `agh completion <shell>`: print the script; the user sources it. */
export function completionCommand(
  positional: string[],
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): number {
  const shell = positional[0]
  if (positional.length !== 1 || !(SHELLS as readonly string[]).includes(shell ?? '')) {
    io.stderr.write(`usage: agh completion ${SHELLS.join('|')}\n`)
    return ExitCode.USAGE
  }
  io.stdout.write(completionScript(shell as Shell))
  return ExitCode.OK
}
