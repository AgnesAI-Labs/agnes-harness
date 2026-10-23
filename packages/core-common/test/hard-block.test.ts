import { describe, expect, it } from 'vitest'
import { HARD_BLOCK_RULES, hardBlockedCommand } from '../src/command-table/hard-block.js'

describe('hardBlockedCommand', () => {
  it.each(HARD_BLOCK_RULES.flatMap((rule) => rule.match.map((sample) => [rule.id, sample] as const)))(
    '%s blocks %j',
    (id, sample) => {
      expect(hardBlockedCommand(sample)).toBe(id)
    },
  )

  it.each(HARD_BLOCK_RULES.flatMap((rule) => rule.notMatch.map((sample) => [rule.id, sample] as const)))(
    '%s lets %j through',
    (_id, sample) => {
      expect(hardBlockedCommand(sample)).toBeUndefined()
    },
  )

  it.each([
    'sudo rm -rf /',
    'sudo -u root rm -rf /',
    'env FOO=1 rm -rf /',
    'FOO=1 rm -rf /',
    String.raw`r\m -rf /`,
    "'r'\\m -rf /",
    'FOO=1 BAR=2 /bin/rm -rf /',
    `${Array.from({ length: 20 }, (_, i) => `V${i}=1`).join(' ')} rm -rf /`,
    'sudo env FOO=1 rm -rf /./',
    'rm -rf /tmp/..',
    'rm -rf /../',
    'command rm -rf /',
    'nohup rm -rf ~ &',
    'timeout 5 rm -rf /',
    'nice -n 5 rm -rf /',
    'exec sudo env rm -rf /',
    '/bin/rm -rf /',
    'git status; rm -rf /',
    'ls && echo hi | rm -rf /',
    "bash -c 'rm -rf /'",
    'sh -lc "sudo rm -rf $HOME"',
    'bash -c "sh -c \'rm -rf /\'"',
    'echo "$(rm -rf /)"',
    'echo `rm -rf /`',
    'rm -rf / > /dev/null',
    'rm -rf "$HOME"',
    'rm -rf /*; ls',
  ])('blocks wrapped or compound %j', (command) => {
    expect(hardBlockedCommand(command)).toBeDefined()
  })

  it.each([
    'rm -rf ./build',
    'rm -rf node_modules dist',
    'dd if=a of=b.img',
    'mkfs.ext4 image.img',
    'git commit -m "fix: rm -rf / handling"',
    'echo rm -rf /',
    "echo '$(rm -rf /)'",
    "echo 'x >/dev/sda'",
    "echo ':(){ :|:& };:'",
    'grep "rm -rf /" notes.md',
    "bash -c 'ls -la'",
    'sudo apt-get install jq',
  ])('does not block %j', (command) => {
    expect(hardBlockedCommand(command)).toBeUndefined()
  })
})
