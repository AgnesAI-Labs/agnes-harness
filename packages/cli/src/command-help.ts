import { usage } from './args.js'
import { BATCH_USAGE } from './commands/batch.js'
import { RUN_USAGE } from './commands/run-usage.js'
import { RUNTIME_USAGE } from './commands/runtime-args.js'
import type { Command } from './types.js'

/** Help is rendered before boot, including forwarded command grammars. */
export function commandHelp(command?: Command, locale = 'en'): string {
  const common = 'Use --yes to confirm reviewed mutations without a TTY. Help never starts the backend.'
  switch (command) {
    case 'app':
      if (locale === 'zh-CN')
        return '用法：agh app clear [--profile NAME] [--json]\nagh app show [--json] | preview <插件#应用> [--json] | adopt <插件#应用> [--yes] [--json]\nclear 无需加载插件即可清除应用展示选择。后台运行时使用在线 CAS，否则使用共享配置锁。show 显示当前应用与候选，preview 显示采纳前的同意预览；adopt 不带 --yes 只打印将要采纳的内容，不发请求。需要管理员连接，后台拒绝原样显示并以退出码 1 结束。'
      return 'Usage: agh app clear [--profile NAME] [--json]\nagh app show [--json] | preview <package#app> [--json] | adopt <package#app> [--yes] [--json]\nClear the presentation selection without loading plugins. Uses online CAS when the daemon is running, otherwise the shared configuration lock. Show prints the current application and its candidates, preview the consent preview; adopt without --yes prints what it would adopt and sends nothing. Needs an admin connection; a refusal is shown as is and exits 1.'
    case 'home':
      return 'Usage: agh home info [--json]\nInspect the versioned home without writes. AGH_HOME selects the home.'
    case 'app-server':
      return 'Usage: agh app-server --stdio [--home <dir>] [--profile <name>] | schema --out <dir>\nAttach JSONL to the existing local daemon, or export the versioned protocol without starting one.'
    case 'runtime':
      return RUNTIME_USAGE
    case 'batch':
      return BATCH_USAGE
    case 'run':
      return RUN_USAGE
    case 'diagnostics':
      return 'Usage: agh diagnostics export [--session <id>] --out <file>\nExport redacted runtime metadata and diagnostic IDs for issue reports.'
    case 'tools':
      return 'Usage: agh tools [--session <key>] [--json] [--cwd <dir>] [--profile <name>]\nList tools, MCP and skills visible to a fresh session or the selected session.'
    case 'serve':
    case 'web':
    case 'start':
      return 'Usage: agh serve [--profile <name>] [--home <path>] [--cwd <path>] [--port <port>]\nStart the local Web listener. --help only prints this message.'
    case 'mcp':
      return `Usage: agh mcp <action> [--profile <name>]\nActions: list, get, status, tools, add, update, trust, enable, disable, test, reconnect, remove\nAdd: agh mcp add <id> --name <name> (--stdio <executable> [--arg <value>] | --http <url> | --sse <url>) [--yes]\nConnection template: agh mcp add [<id>] --preset playwright [--sandbox-workspace <absolute-path>] [--yes]\nTrust/enable/test: agh mcp <action> <id> --expected-revision <revision> [--yes]\n${common}`
    case 'skills':
      return `Usage: agh skills list|refresh|trust [--profile <name>]\nList: agh skills list [--workspace-id <id>] [--cursor <cursor>]\nRefresh: agh skills refresh [--workspace-id <id>] [--root-key <key>] [--yes]\nThe current directory is registered automatically; its workspaceId is printed.\nTrust: agh skills trust <resourceId> <revision> [trusted|rejected] [--yes]\n${common}`
    case 'resources':
      return `Usage: agh resources list|get|operation|cancel|enable|disable\nList: agh resources list [--kind skill|mcp] [--workspace-id <id>]\nEnable/disable: agh resources <action> <resourceId> --expected-revision <revision> [--yes]\n${common}`
    case 'sessions':
      return 'Usage: agh sessions list [--cwd <dir>] [--archived] | show <key> | verify <key> | pin|unpin|archive|unarchive <key> | rename <key> <title...> | search <query...> | groups | deliverables <key> [--save <n|id> [--out <path>] [--force]] | migrate <key> [--profile <name>] [--json]\nDeliverables lists the files a session delivered; --save downloads one after checking size and sha256, into the current directory unless --out is given, and refuses to replace an existing file without --force.\nSearch needs an admin connection; the daemon refusal is shown as is.\nMigrate a closed historical session to compatible current plugins, preserving its loop and composition.'
    case 'approvals':
      return 'Usage: agh approvals grants <sessionId> [--json] | revoke <sessionId> <grantId> [--json]\nList the approval grants in force for a session ("this session" and "always") and withdraw one. Needs an admin connection; the daemon refusal is shown as is.'
    case 'schedules':
      return 'Usage: agh schedules [list [--session <key>] [--archived]] | show <id> | pause|resume|run|archive <id> [--json]\nagh schedules add --prompt <text> (--every <90s|30m|2h|1d> | --cron <expr> | --at <iso> | --daily <HH:MM> | --weekly <mon,wed@HH:MM>) [--tz <zone>] [--title <t>] [--session <key> | --new-session [--cwd <dir>]] [--unattended notify|refuse]\nagh schedules edit <id> [same flags; only what is given changes]\nWith neither --session nor --new-session a task opens a new session in the current directory. run starts the task now. Needs an admin connection; a refusal prints its code and exits 1.'
    case 'triggers':
      return 'Usage: agh triggers [list] | add --file <rule.json|-> | edit <ruleId> --file <rule.json|-> | remove <ruleId> | test <ruleId> [--payload <payload.json|->] | configure --file <config.json|-> [--json]\nWebhook rules and the listener configuration. Rule and configuration JSON is checked against the protocol schema before anything is sent. Needs an admin connection; a refusal prints its code and exits 1.'
    case 'settings':
      return 'Usage: agh settings [--json]\nagh settings <section> [get] [--json] | set (--file <settings.json|-> | --text <text>) | test --text <query> [<provider>]\nSections: model-slots, child-engines, auto-review, system-prompt, memory, observability, search, session-defaults; agh settings lists them with a description. get prints one line per value, --json the daemon result; set reads JSON (a get --json document works for most sections) and checks it against the protocol schema before anything is sent. system-prompt set --text replaces the whole prompt (needs --yes; empty text removes the replacement). memory works on --cwd (default: this directory). test exists only for search. Credentials: agh credentials; accounts: agh config. Needs an admin connection; a refusal is shown as it comes and exits 1.'
    case 'agents':
      return "Usage: agh agents [--all] [--json]\nThe daemon's sessions with their state and queue: key, title, loop or preset, state, queued inputs, last activity. The 50 most recent unarchived sessions unless --all. State is paused, queued (inputs wait behind the current turn), open (live in the daemon with nothing queued; a turn may still be running, the daemon gives clients no busy flag), closed (not live in the daemon) or unknown (that session could not be read). agh sessions list is the archive and grouping view; agh agents is the run and queue view. Read-only."
    case 'credentials':
      return 'Usage: agh credentials [list] | rename <id> <name...> | delete <id> [--yes [--force]] [--json]\nGeneric API-key credentials: id, name, creation time and what uses them; a secret value is never shown. delete without --yes only shows what would be deleted; a credential still in use also needs --force. Adding or replacing a value is not available here: use agh config. Needs an admin connection; a refusal is shown as it comes and exits 1.'
    case 'plugin':
      return 'Usage: agh plugin test [folder] [-- <test-runner args>]\nRun the package test script with installed author testkit dependencies, an isolated home and no inherited model keys. No backend or dependency installation is started.'
    case 'plugins':
      return `Usage: agh plugins add <url|path> [--yes]\nagh plugins pack <folder> [output.tgz]\nagh plugins trust|enable <id> [--yes]\nagh plugins reload [id] [--profile <name>]\nagh plugins candidates list|show <candidate-id>\nagh plugins candidates approve|reject <candidate-id> --candidate-hash <sha256> --review-hash <sha256>\nagh plugins provenance <id> [--profile <name>] [--json]\nagh plugins publication-status [--profile <name>] [--json]\nagh plugins config get <id> | validate|set <id> [<row>] --file <file|-> [--json]\nagh plugins tree [list] | show | apply --file <artifact|-> [--yes] | rollback [--yes] [--json]\nagh plugins generations [--json]\nConfig values come from a JSON file (--file, or - for stdin), never from the command line; set validates first and saves nothing when the value is invalid. Secret fields are never printed. Tree apply takes the artifact printed by tree show --json; apply and rollback without --yes only print what they would do. Needs an admin connection; a refusal is shown as is and exits 1.\nAdd reviews capabilities and installs, trusts and enables that exact version. Pack does not start the backend.\n${common}`
    case 'package':
    case 'install':
      return `Usage: agh install <source> [--yes]\nagh package inspect|add <source> [--yes]\nagh package trust <id> [<integrity> <capabilityHash>] [--yes]\nagh package enable|disable|rollback|remove <id> [--yes]\nagh package status|list|catalog|operation|cancel|source-policy [--json]\n${common}`
    default:
      return usage(locale)
  }
}
