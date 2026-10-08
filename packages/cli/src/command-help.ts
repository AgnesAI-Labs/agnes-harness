import { usage } from './args.js'
import { RUN_USAGE } from './commands/run.js'
import type { Command } from './types.js'

/** Help is rendered before boot, including forwarded command grammars. */
export function commandHelp(command?: Command): string {
  const common = 'Use --yes to confirm reviewed mutations without a TTY. Help never starts the backend.'
  switch (command) {
    case 'app-server':
      return 'Usage: agh app-server --stdio [--home <dir>] [--profile <name>] | schema --out <dir>\nAttach JSONL to the existing local daemon, or export the versioned protocol without starting one.'
    case 'run':
      return RUN_USAGE
    case 'tools':
      return 'Usage: agh tools [--session <key>] [--json] [--cwd <dir>] [--profile <name>]\nList tools, MCP and skills visible to a fresh session or the selected session.'
    case 'serve':
    case 'web':
    case 'start':
      return 'Usage: agh serve [--profile <name>] [--home <path>] [--cwd <path>] [--port <port>]\nStart the local Web listener. --help only prints this message.'
    case 'mcp':
      return `Usage: agh mcp <action> [--profile <name>]\nActions: list, get, status, tools, add, update, trust, enable, disable, test, reconnect, remove\nAdd: agh mcp add <id> --name <name> (--stdio <executable> [--arg <value>] | --http <url> | --sse <url>) [--yes]\nTrust/enable/test: agh mcp <action> <id> --expected-revision <revision> [--yes]\n${common}`
    case 'skills':
      return `Usage: agh skills list|refresh|trust [--profile <name>]\nList: agh skills list [--workspace-id <id>] [--cursor <cursor>]\nRefresh: agh skills refresh [--workspace-id <id>] [--root-key <key>] [--yes]\nThe current directory is registered automatically; its workspaceId is printed.\nTrust: agh skills trust <resourceId> <revision> [trusted|rejected] [--yes]\n${common}`
    case 'resources':
      return `Usage: agh resources list|get|operation|cancel|enable|disable\nList: agh resources list [--kind skill|mcp] [--workspace-id <id>]\nEnable/disable: agh resources <action> <resourceId> --expected-revision <revision> [--yes]\n${common}`
    case 'sessions':
      return 'Usage: agh sessions list [--cwd <dir>] | show <key> | migrate <key> [--profile <name>] [--json]\nMigrate a closed historical session to compatible current plugins, preserving its loop and composition.'
    case 'plugins':
      return `Usage: agh plugins add <url|path> [--yes]\nagh plugins pack <folder> [output.tgz]\nagh plugins trust|enable <id> [--yes]\nagh plugins reload [id] [--profile <name>]\nagh plugins publication-status [--profile <name>] [--json]\nAdd reviews capabilities and installs, trusts and enables that exact version. Pack does not start the backend.\n${common}`
    case 'package':
    case 'install':
      return `Usage: agh install <source> [--yes]\nagh package inspect|add <source> [--yes]\nagh package trust <id> [<integrity> <capabilityHash>] [--yes]\nagh package enable|disable|rollback|remove <id> [--yes]\nagh package status|list|catalog|operation|cancel\n${common}`
    default:
      return usage()
  }
}
