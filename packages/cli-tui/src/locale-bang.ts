import type { Locale } from './locale.js'

/** Strings of `!` / `!!` shell lines: kept beside the other locale files so locale-extended.ts stays small. */
export type BangKey =
  | 'bang.running'
  | 'bang.exit'
  | 'bang.stopped'
  | 'bang.noExit'
  | 'bang.remote'
  | 'bang.omitted'
  | 'bang.unsupported'
  | 'bang.denied'
  | 'bang.empty'
  | 'bang.chips'
  | 'bang.tooLong'
  | 'bang.busy'
  | 'bang.interrupted'
  | 'bang.killing'
  | 'bang.chip'
  | 'bang.attached'
  | 'bang.lost'
  | 'bang.keys'
  | 'bang.help'

export const BANG_DICT: Record<Locale, Record<BangKey, string>> = {
  en: {
    'bang.running': 'running… Ctrl-C interrupts it, a second Ctrl-C kills it',
    'bang.exit': 'exit {code} · {secs}s',
    'bang.stopped': 'stopped (exit {code}) · {secs}s',
    'bang.noExit': 'no exit code · {secs}s',
    'bang.remote': 'runs on the daemon host',
    'bang.omitted': '… {n} earlier lines not shown',
    'bang.unsupported': 'this daemon does not support ! commands',
    'bang.denied': 'this session does not allow running commands',
    'bang.empty': 'type a command after !',
    'bang.chips': 'expand or remove pasted blocks before running a ! command',
    'bang.tooLong': 'that command is longer than {max} bytes',
    'bang.busy': 'a ! command is still running; wait for it or press Ctrl-C',
    'bang.interrupted': 'sent Ctrl-C to the command; press Ctrl-C again to kill it',
    'bang.killing': 'killing the command',
    'bang.chip': '[Shell #{n}]',
    'bang.attached': '{chip} goes with your next message; delete it to keep the output to yourself',
    'bang.lost': 'lost track of the command: {reason}',
    'bang.keys':
      'Prompt: a line starting with ! runs as a shell command and its result goes with your next message; !! keeps the result to yourself. Ctrl-C interrupts it, twice kills it',
    'bang.help':
      '!COMMAND runs a shell command from the prompt (on the daemon host when connected remotely); its result goes with your next message. !!COMMAND keeps the result local',
  },
  'zh-CN': {
    'bang.running': '运行中… 按 Ctrl-C 中断，再按一次强制结束',
    'bang.exit': '退出码 {code} · {secs} 秒',
    'bang.stopped': '已停止（退出码 {code}）· {secs} 秒',
    'bang.noExit': '无退出码 · {secs} 秒',
    'bang.remote': '在 daemon 所在主机上运行',
    'bang.omitted': '……前面 {n} 行未显示',
    'bang.unsupported': '这个 daemon 不支持 ! 命令',
    'bang.denied': '当前会话不允许运行命令',
    'bang.empty': '! 后面请输入命令',
    'bang.chips': '运行 ! 命令前，请先展开或删除粘贴的内容块',
    'bang.tooLong': '命令超过 {max} 字节',
    'bang.busy': '已有一条 ! 命令在运行，请等它结束或按 Ctrl-C',
    'bang.interrupted': '已向命令发送 Ctrl-C；再按一次 Ctrl-C 强制结束',
    'bang.killing': '正在强制结束命令',
    'bang.chip': '[Shell #{n}]',
    'bang.attached': '{chip} 会随下一条消息发出；删掉它则结果只留给自己',
    'bang.lost': '无法继续跟踪命令：{reason}',
    'bang.keys':
      '输入框：以 ! 开头的一行作为 shell 命令运行，结果随下一条消息发出；!! 开头则结果只留给自己。Ctrl-C 中断，连按两次强制结束',
    'bang.help':
      '!命令 在输入框里运行 shell 命令（远程连接时在 daemon 所在主机上运行），结果随下一条消息发出。!!命令 的结果只留在本地',
  },
}
