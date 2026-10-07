import type { LocaleCatalog } from '@agnes/web-ui'
export const JOBS_NAMESPACE = '@agnes/web/jobs'
export const jobsCatalog: LocaleCatalog = {
  en: {
    terminalHelp:
      'Open an interactive terminal under this session’s sandbox preset. Refresh reconnects; Close kills the terminal and its processes.',
    jobsHelp:
      'View shell, persistent shell, PTY and child-agent jobs owned by this session. Jobs survive turns, not a daemon restart.',
    session: 'Session key',
    shell: 'Shell',
    open: 'Open terminal',
    close: 'Close terminal',
    interrupt: 'Interrupt',
    refresh: 'Refresh',
    unavailable:
      'Jobs are unavailable. Check the session key, enabled jobs extension and interactive sandbox support.',
    output: 'Output',
    keyboard:
      'Focus the terminal to type, paste or use arrow keys. Ctrl+C interrupts; Tab is sent to the terminal; Shift+Tab moves focus out.',
    jobs: 'Session jobs',
    kind: 'Kind',
    command: 'Command',
    status: 'Status',
    actions: 'Actions',
    kill: 'Kill',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    killed: 'Stopped',
    completedNotice: 'Job finished',
  },
  'zh-CN': {
    terminalHelp: '在此会话的沙箱预设下打开交互终端。刷新会重新连接；关闭会终止终端及其进程。',
    jobsHelp:
      '查看属于此会话的 shell、持久 shell、PTY 和子代理作业。作业可跨轮次保留，守护进程重启后不会恢复。',
    session: '会话标识',
    shell: 'Shell',
    open: '打开终端',
    close: '关闭终端',
    interrupt: '中断',
    refresh: '刷新',
    unavailable: '作业不可用。请检查会话标识、jobs 扩展是否启用及沙箱是否支持交互进程。',
    output: '输出',
    keyboard: '聚焦终端即可输入、粘贴和使用方向键。Ctrl+C 中断；Tab 发送到终端；Shift+Tab 移出焦点。',
    jobs: '会话作业',
    kind: '类型',
    command: '命令',
    status: '状态',
    actions: '操作',
    kill: '终止',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    killed: '已停止',
    completedNotice: '作业结束',
  },
}
