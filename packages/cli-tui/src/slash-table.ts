import type { ExtendedKey } from './locale-extended.js'

/** The slash menu's rows: the name, the argument shape and the locale keys of both descriptions. */
export type SlashCommand = {
  name: string
  /** Argument shape shown dimmed next to the name in the slash menu, e.g. `<seq>`. */
  args?: string
  /** Locale key of the one-line description; translated when the menu renders. */
  descriptionKey: ExtendedKey
  /** Locale key of the short summary shown beside the name in the slash menu. */
  summaryKey: ExtendedKey
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', descriptionKey: 'commands.help', summaryKey: 'commands.helpSummary' },
  { name: '/quit', descriptionKey: 'commands.quit', summaryKey: 'commands.quitSummary' },
  { name: '/new', args: '[dir]', descriptionKey: 'commands.new', summaryKey: 'commands.newSummary' },
  {
    name: '/resume',
    args: '[id|all]',
    descriptionKey: 'commands.resume',
    summaryKey: 'commands.resumeSummary',
  },
  {
    name: '/import',
    args: '[<file> [--from claude-code|codex|pi|auto]]',
    descriptionKey: 'commands.import',
    summaryKey: 'commands.importSummary',
  },
  { name: '/sessions', descriptionKey: 'commands.sessions', summaryKey: 'commands.sessionsSummary' },
  { name: '/pin', descriptionKey: 'commands.pin', summaryKey: 'commands.pinSummary' },
  { name: '/unpin', descriptionKey: 'commands.unpin', summaryKey: 'commands.unpinSummary' },
  {
    name: '/rename',
    args: '<title>',
    descriptionKey: 'commands.rename',
    summaryKey: 'commands.renameSummary',
  },
  { name: '/archive', descriptionKey: 'commands.archive', summaryKey: 'commands.archiveSummary' },
  {
    name: '/search',
    args: '<query>',
    descriptionKey: 'commands.search',
    summaryKey: 'commands.searchSummary',
  },
  { name: '/cost', descriptionKey: 'commands.cost', summaryKey: 'commands.costSummary' },
  { name: '/usage', descriptionKey: 'commands.usage', summaryKey: 'commands.usageSummary' },
  {
    name: '/computer-use',
    args: 'status',
    descriptionKey: 'commands.computerUse',
    summaryKey: 'commands.computerUseSummary',
  },
  {
    name: '/doctor',
    args: 'computer-use',
    descriptionKey: 'commands.doctor',
    summaryKey: 'commands.doctorSummary',
  },
  { name: '/rewind', args: '[seq]', descriptionKey: 'commands.rewind', summaryKey: 'commands.rewindSummary' },
  {
    name: '/undo',
    args: '[turn|confirm|cancel]',
    descriptionKey: 'commands.undo',
    summaryKey: 'commands.undoSummary',
  },
  {
    name: '/compact',
    args: '[instructions]',
    descriptionKey: 'commands.compact',
    summaryKey: 'commands.compactSummary',
  },
  {
    name: '/goal',
    args: '[create|edit|pause|resume|complete|clear] ...',
    descriptionKey: 'commands.goal',
    summaryKey: 'commands.goalSummary',
  },
  {
    name: '/plan',
    args: '[on|off|status|pending|instruction]',
    descriptionKey: 'commands.plan',
    summaryKey: 'commands.planSummary',
  },
  {
    name: '/preset',
    args: '<name>',
    descriptionKey: 'commands.preset',
    summaryKey: 'commands.presetSummary',
  },
  {
    name: '/theme',
    args: '[auto|light|dark|mono]',
    descriptionKey: 'commands.theme',
    summaryKey: 'commands.themeSummary',
  },
  {
    name: '/notify',
    args: '[on|bell|off]',
    descriptionKey: 'commands.notify',
    summaryKey: 'commands.notifySummary',
  },
  { name: '/keys', descriptionKey: 'commands.keys', summaryKey: 'commands.keysSummary' },
  { name: '/mouse', descriptionKey: 'commands.mouse', summaryKey: 'commands.mouseSummary' },
  { name: '/thinking', descriptionKey: 'commands.thinking', summaryKey: 'commands.thinkingSummary' },
  {
    name: '/model',
    args: '[<slot> <route>/<model> [<thinking>]]',
    descriptionKey: 'commands.model',
    summaryKey: 'commands.modelSummary',
  },
  { name: '/yolo', args: '[on|off]', descriptionKey: 'commands.yolo', summaryKey: 'commands.yoloSummary' },
  {
    name: '/grants',
    args: '[revoke <n|id>]',
    descriptionKey: 'commands.grants',
    summaryKey: 'commands.grantsSummary',
  },
  {
    name: '/deliverables',
    args: '[save <n|id> [path]]',
    descriptionKey: 'commands.deliverables',
    summaryKey: 'commands.deliverablesSummary',
  },
  {
    name: '/attach',
    args: '<path>',
    descriptionKey: 'commands.attach',
    summaryKey: 'commands.attachSummary',
  },
  {
    name: '/paste',
    descriptionKey: 'commands.paste',
    summaryKey: 'commands.pasteSummary',
  },
  {
    name: '/schedule',
    args: '[list|every <interval> <prompt>|daily <HH:MM> <prompt>|delete <n|id>|confirm|cancel]',
    descriptionKey: 'commands.schedule',
    summaryKey: 'commands.scheduleSummary',
  },
  {
    name: '/loop',
    args: '<interval> <prompt>',
    descriptionKey: 'commands.loop',
    summaryKey: 'commands.loopSummary',
  },
  {
    name: '/export',
    args: '[agnes|html|sharegpt|claude-code] [path]',
    descriptionKey: 'commands.export',
    summaryKey: 'commands.exportSummary',
  },
  {
    name: '/rate',
    args: 'up|down [reason]',
    descriptionKey: 'commands.rate',
    summaryKey: 'commands.rateSummary',
  },
  {
    name: '/heads-up',
    args: '[on|off]',
    descriptionKey: 'commands.headsUp',
    summaryKey: 'commands.headsUpSummary',
  },
  { name: '/refine', descriptionKey: 'commands.refine', summaryKey: 'commands.refineSummary' },
  { name: '/packages', descriptionKey: 'commands.packages', summaryKey: 'commands.packagesSummary' },
  {
    name: '/install',
    args: '<source>|confirm|cancel',
    descriptionKey: 'commands.install',
    summaryKey: 'commands.installSummary',
  },
  {
    name: '/package',
    args: '[status|catalog|inspect|trust|enable|disable|update|rollback|remove|operation|cancel] ...',
    descriptionKey: 'commands.package',
    summaryKey: 'commands.packageSummary',
  },
  { name: '/skills', descriptionKey: 'commands.skills', summaryKey: 'commands.skillsSummary' },
  {
    name: '/skill',
    args: 'invoke <name> [arguments]|refresh|trust ...',
    descriptionKey: 'commands.skill',
    summaryKey: 'commands.skillSummary',
  },
  { name: '/mcp', args: '<action> ...', descriptionKey: 'commands.mcp', summaryKey: 'commands.mcpSummary' },
  { name: '/context', descriptionKey: 'commands.context', summaryKey: 'commands.contextSummary' },
  {
    name: '/agents',
    args: '[stop <n|id>|resume <n|id> <message>]',
    descriptionKey: 'commands.agents',
    summaryKey: 'commands.agentsSummary',
  },
  {
    name: '/jobs',
    args: '[stop <n|id>]',
    descriptionKey: 'commands.jobs',
    summaryKey: 'commands.jobsSummary',
  },
  {
    name: '/queue',
    args: '[edit|drop|now|steer <n>]',
    descriptionKey: 'commands.queue',
    summaryKey: 'commands.queueSummary',
  },
  { name: '/status', descriptionKey: 'commands.status', summaryKey: 'commands.statusSummary' },
  { name: '/copy', args: '[n|code]', descriptionKey: 'commands.copy', summaryKey: 'commands.copySummary' },
  {
    name: '/diff',
    args: '[turn] [path]',
    descriptionKey: 'commands.diff',
    summaryKey: 'commands.diffSummary',
  },
  { name: '/init', descriptionKey: 'commands.init', summaryKey: 'commands.initSummary' },
  {
    name: '/review',
    args: '[scope]',
    descriptionKey: 'commands.review',
    summaryKey: 'commands.reviewSummary',
  },
  {
    name: '/terminal-setup',
    args: '[apply|confirm|cancel]',
    descriptionKey: 'commands.terminalSetup',
    summaryKey: 'commands.terminalSetupSummary',
  },
  { name: '/bg', args: '[prompt]', descriptionKey: 'commands.bg', summaryKey: 'commands.bgSummary' },
  {
    name: '/memory',
    args: '[list|show <name>|add <text>|edit <name>|confirm|cancel]',
    descriptionKey: 'commands.memory',
    summaryKey: 'commands.memorySummary',
  },
  { name: '/btw', args: '<question>', descriptionKey: 'commands.btw', summaryKey: 'commands.btwSummary' },
  {
    name: '/todos',
    args: '[auto|show|hide]',
    descriptionKey: 'commands.todos',
    summaryKey: 'commands.todosSummary',
  },
  {
    name: '/expand',
    args: 'all|none',
    descriptionKey: 'commands.expand',
    summaryKey: 'commands.expandSummary',
  },
]
