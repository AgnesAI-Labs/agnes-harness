import { splitShellCommand } from './split.js'

/**
 * Commands refused in every permission mode, because they are almost never legitimate and their
 * damage cannot be undone. This is code, not preset data: a preset (full-access clears the command
 * table), yolo, `approvals.mode: off` and any grant cannot reach it.
 *
 * It is text policy, not a parser or a sandbox. Obfuscation can get past it; the real boundary stays
 * the sandbox and the hard path denials. Parse failure never blocks by itself: the whole string and
 * every literal piece that can be pulled out are scanned instead.
 */
export type HardBlockRule = {
  id: string
  description: string
  /** Commands that must be blocked. Checked when this module loads. */
  match: readonly string[]
  /** Look-alikes that must not be blocked. Checked when this module loads. */
  notMatch: readonly string[]
  /** One command (wrapper prefixes already removed). */
  command?: (words: readonly string[]) => boolean
  /** The whole text with whitespace removed. */
  text?: (squashed: string) => boolean
}

const basename = (word: string): string => (word.replace(/^\\/, '').split(/[\\/]/).pop() ?? '').toLowerCase()
const flags = (words: readonly string[]): string[] => {
  const end = words.indexOf('--')
  return (end < 0 ? words : words.slice(0, end)).filter((word) => word.startsWith('-'))
}
const operands = (words: readonly string[]): string[] => {
  const end = words.indexOf('--')
  return [
    ...words.filter((word, i) => !word.startsWith('-') && (end < 0 || i < end)),
    ...(end < 0 ? [] : words.slice(end + 1)),
  ]
}
const WHOLE_DISK = /^(?:\/+\*?|(?:~|\$HOME|\$\{HOME\})(?:\/+\*?)?)$/
// Normalize only literal absolute paths. Variables and shell programs stay text-policy inputs.
function wholeDisk(operand: string): boolean {
  if (WHOLE_DISK.test(operand)) return true
  if (!operand.startsWith('/')) return false
  const parts: string[] = []
  for (const part of operand.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.length === 0 || (parts.length === 1 && parts[0] === '*')
}
const BLOCK_DEVICE = /\/dev\/(?:sd|nvme|disk|rdisk|hd|mmcblk)/

export const HARD_BLOCK_RULES: readonly HardBlockRule[] = [
  {
    id: 'rm-root-or-home',
    description: 'recursive delete of the root or home directory',
    match: [
      'rm -rf /',
      'rm -fr /*',
      'rm -r ~',
      'rm -Rf ~/',
      'rm -rf $HOME',
      'rm --recursive //',
      'rm --no-preserve-root x',
      'rm -rf -- /',
    ],
    notMatch: [
      'rm -rf ./build',
      'rm -rf ~/projects/x',
      'rm /',
      'rm file',
      'ls -rf /',
      'rm -rf /tmp/x',
      'rm -rf $HOME/.cache',
    ],
    command(words) {
      if (basename(words[0] ?? '') !== 'rm') return false
      const rest = words.slice(1)
      if (rest.includes('--no-preserve-root')) return true
      const recursive = flags(rest).some((flag) => flag === '--recursive' || /^-[a-zA-Z]*[rR]/.test(flag))
      return recursive && operands(rest).some(wholeDisk)
    },
  },
  {
    id: 'fork-bomb',
    description: 'fork bomb',
    match: [':(){ :|:& };:', ':(){:|:&};:', 'bomb() { bomb | bomb & }; bomb', 'echo x; :(){ :|: & };:'],
    notMatch: ['f() { g | h; }; f', 'echo hello'],
    text: (squashed) => /([\w:.-]+)\(\)\{\1\|\1&\};?\1/.test(squashed),
  },
  {
    id: 'block-device-write',
    description: 'writing to a block device',
    match: [
      'mkfs.ext4 /dev/sda1',
      'mkfs /dev/nvme0n1',
      'dd if=x of=/dev/sda',
      'dd if=/dev/zero of=/dev/disk2 bs=1m',
      'echo x > /dev/sda',
      'cat x >/dev/nvme0n1',
    ],
    notMatch: [
      'mkfs.ext4 disk.img',
      'dd if=a of=b.img',
      'echo x > /dev/null',
      'dd if=/dev/sda of=copy.img',
      'ls /dev/sda',
    ],
    command(words) {
      const name = basename(words[0] ?? '')
      if (/^mkfs(?:\..+)?$/.test(name)) return words.slice(1).some((word) => word.startsWith('/dev/'))
      return name === 'dd' && words.slice(1).some((word) => word.startsWith('of=') && BLOCK_DEVICE.test(word))
    },
    text: (squashed) => />\/dev\/(?:sd|nvme|disk|rdisk|hd|mmcblk)/.test(squashed),
  },
  {
    id: 'disk-erase',
    description: 'whole-disk erase or format',
    match: [
      'diskutil eraseDisk JHFS+ X disk2',
      'diskutil zeroDisk disk2',
      'diskutil secureErase 0 disk2',
      'format c:',
      'FORMAT D: /q',
    ],
    notMatch: ['diskutil list', 'diskutil info disk2', 'format file.ts', 'echo format c:'],
    command(words) {
      const name = basename(words[0] ?? '')
      if (name === 'diskutil') return /^(?:erasedisk|zerodisk|secureerase)$/i.test(words[1] ?? '')
      return /^format(?:\.com)?$/.test(name) && words.slice(1).some((word) => /^[a-z]:\\?$/i.test(word))
    },
  },
]

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const MAX_DEPTH = 3
const optionWithValue: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D', '-R'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S'],
  nice: ['-n'],
  exec: ['-a'],
}

/** Drop `sudo`, `env`, `command`, `exec`, `nohup`, `timeout` and `nice` in front of the real command. */
function unwrap(words: readonly string[]): readonly string[] {
  let rest = words
  while (rest.length > 0) {
    if (/^[A-Za-z_]\w*\+?=/.test(rest[0] as string)) {
      rest = rest.slice(1)
      continue
    }
    const name = basename(rest[0] as string)
    if (!['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'timeout', 'nice'].includes(name)) return rest
    const valued = optionWithValue[name] ?? []
    let i = 1
    for (; i < rest.length; i++) {
      const word = rest[i] as string
      if (word === '--') {
        i++
        break
      }
      if (valued.includes(word)) i++
      else if (word.startsWith('-') || (name === 'env' && /^[A-Za-z_]\w*=/.test(word))) continue
      else break
    }
    if (name === 'timeout') i++ // the duration
    rest = rest.slice(i)
  }
  return rest
}

/** Quote-aware lenient split: separators and quotes are honoured, anything else is left alone. */
function looseSegments(text: string, honourQuotes: boolean): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let has = false
  let quote = ''
  const endWord = () => {
    if (has) words.push(word)
    word = ''
    has = false
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (honourQuotes && ch === '\\' && quote !== "'") {
      const next = text[i + 1]
      if (next !== undefined && (!quote || '$`"\\\n'.includes(next))) {
        if (next !== '\n') {
          word += next
          has = true
        }
        i++
        continue
      }
    }
    if (quote) {
      if (ch === quote) quote = ''
      else word += ch
      continue
    }
    if ((ch === '"' || ch === "'") && honourQuotes) {
      quote = ch
      has = true
      continue
    }
    if (ch === '"' || ch === "'") continue
    if (';&|\n(){}`'.includes(ch)) endSegment()
    else if (ch === '$' && text[i + 1] === '(') {
      endSegment()
      i++
    } else if (/\s/.test(ch)) endWord()
    else {
      word += ch
      has = true
    }
  }
  endSegment()
  return segments
}

function blockedCommand(words: readonly string[], depth: number): string | undefined {
  const real = unwrap(words)
  if (real.length === 0) return undefined
  for (const rule of HARD_BLOCK_RULES) if (rule.command?.(real)) return rule.id
  if (SHELLS.has(basename(real[0] as string)) && depth < MAX_DEPTH) {
    const flag = real.findIndex((word, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(word))
    const payload = flag > 0 ? real[flag + 1] : undefined
    if (payload !== undefined) return hardBlockedAt(payload, depth + 1)
  }
  return undefined
}

function hardBlockedAt(command: string, depth: number): string | undefined {
  const strict = splitShellCommand(command)
  // Fully parsed commands have no expansions or redirections; quoted words are data.
  const squashed = command.replace(/\s+/g, '')
  if (!strict) for (const rule of HARD_BLOCK_RULES) if (rule.text?.(squashed)) return rule.id
  const views = [
    ...(strict ?? looseSegments(command, true)),
    // Literal pieces hidden inside quotes: `echo "$(rm -rf /)"`.
    ...(strict ? [] : looseSegments(command, false)),
  ]
  for (const words of views) {
    const id = blockedCommand(words, depth)
    if (id) return id
  }
  return undefined
}

/** The id of the first hard-block rule the command text trips, if any. */
export function hardBlockedCommand(command: string): string | undefined {
  return hardBlockedAt(command, 0)
}

for (const rule of HARD_BLOCK_RULES) {
  for (const sample of rule.match)
    if (hardBlockedCommand(sample) !== rule.id) throw new Error(`hard-block ${rule.id}: ${sample} must match`)
  for (const sample of rule.notMatch)
    if (hardBlockedCommand(sample) !== undefined)
      throw new Error(`hard-block ${rule.id}: ${sample} must not match`)
}
