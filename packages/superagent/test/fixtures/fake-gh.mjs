#!/usr/bin/env node
// A scripted stand-in for the `gh` CLI.
//
// FAKE_GH_SCRIPT is a JSON file (or an inline JSON object) of the shape
//   { login?: string, banner?: string, rules?: [{ args?: string[], pattern?: string, stdout?: string, stderr?: string,
//     exit?: number, times?: number, delayMs?: number }] }
// A rule matches when its `args` are a prefix of the call's arguments, or when its `pattern` (a regular expression)
// matches the arguments joined by spaces; rules are tried in order and a rule with `times` stops matching once it has
// answered that many calls. `delayMs` holds the answer back that long, as a slow or hanging `gh` does. Every call is appended to FAKE_GH_LOG as one JSON
// line ({ argv, stdin?, matched }). `gh api user` answers with the script's login (`--jq .login` prints it bare),
// a bare `gh` prints the banner, and a call no rule matches fails with exit 1 so a test never passes on a guess.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const source = process.env.FAKE_GH_SCRIPT ?? ''
const logPath = process.env.FAKE_GH_LOG
const script = source.trimStart().startsWith('{')
  ? JSON.parse(source)
  : source && existsSync(source)
    ? JSON.parse(readFileSync(source, 'utf8'))
    : {}
const rules = script.rules ?? []

// Rule usage is kept next to the log so `times` holds across the separate processes of one test.
const usagePath = logPath ? `${logPath}.usage` : undefined
const usage = usagePath && existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, 'utf8')) : {}

// `--input -` and a `-F <field>=@-` field read standard input.
const reads = argv.includes('--input') || argv.some((arg) => arg.endsWith('=@-'))
const stdin = !process.stdin.isTTY && reads ? readFileSync(0, 'utf8') : undefined

function reply(entry) {
  if (logPath)
    appendFileSync(
      logPath,
      `${JSON.stringify({ argv, ...(stdin !== undefined ? { stdin } : {}), ...entry })}\n`,
    )
  process.exit(entry.exit ?? 0)
}
function out(stdout, stderr, exit, matched) {
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  reply({ matched, exit })
}

const matches = (rule) =>
  rule.pattern !== undefined
    ? new RegExp(rule.pattern).test(argv.join(' '))
    : (rule.args ?? []).every((arg, at) => argv[at] === arg)
const index = rules.findIndex(
  (rule, i) => matches(rule) && (rule.times === undefined || (usage[i] ?? 0) < rule.times),
)
if (index >= 0) {
  usage[index] = (usage[index] ?? 0) + 1
  if (usagePath) writeFileSync(usagePath, JSON.stringify(usage))
  const rule = rules[index]
  if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs))
  out(rule.stdout, rule.stderr, rule.exit ?? 0, true)
}
if (argv[0] === 'api' && argv[1] === 'user' && script.login !== undefined) {
  const jq = argv.indexOf('--jq')
  const bare = jq >= 0 && argv[jq + 1] === '.login'
  out(bare ? `${script.login}\n` : `${JSON.stringify({ login: script.login })}\n`, '', 0, true)
}
if (argv.length === 0 && script.banner !== undefined) out(`${script.banner}\n`, '', 0, true)
out('', `fake-gh: no scripted reply for: gh ${argv.join(' ')}\n`, 1, false)
