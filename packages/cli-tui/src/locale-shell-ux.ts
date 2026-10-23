import type { ThemeProblem } from './custom-theme.js'
import type { Locale } from './locale.js'

/** Strings of Ctrl-Z suspend and custom colour themes, kept out of the larger locale files. */
export type ShellUxKey =
  | 'keys.act.suspend'
  | 'theme.custom'
  | 'theme.rejected'
  | 'theme.fellBack'
  | `theme.problem.${ThemeProblem['code']}`

export const SHELL_UX_DICT: Record<Locale, Record<ShellUxKey, string>> = {
  en: {
    'keys.act.suspend':
      'Suspend to the shell when the draft is empty (otherwise this key undoes); fg brings it back',
    'theme.custom': 'Custom · {name}',
    'theme.rejected': 'theme {name} not applied: {reason}',
    'theme.fellBack': 'theme {name} could not be loaded ({reason}); using auto',
    'theme.problem.name': 'a theme name is 1 to 32 characters of a-z, 0-9 and -',
    'theme.problem.missing': 'there is no such file in the tui-themes folder',
    'theme.problem.symlink': 'symbolic links are not followed',
    'theme.problem.size': 'the file is over 8 KB',
    'theme.problem.json': 'the file is not valid JSON',
    'theme.problem.shape': 'the file must be a JSON object, with "tones" an object of colours',
    'theme.problem.unknownKey': 'unknown key "{detail}"',
    'theme.problem.badValue': '"{detail}" must be a colour like #rrggbb',
    'theme.problem.extends': '"extends" must be "dark" or "light"',
  },
  'zh-CN': {
    'keys.act.suspend': '输入框为空时挂起到 shell（有内容时此键仍是撤销）；fg 恢复',
    'theme.custom': '自定义 · {name}',
    'theme.rejected': 'theme {name} 未应用：{reason}',
    'theme.fellBack': 'theme {name} 无法加载（{reason}），改用 auto',
    'theme.problem.name': '主题名只能是 1 到 32 个 a-z、0-9 或 -',
    'theme.problem.missing': 'tui-themes 文件夹里没有这个文件',
    'theme.problem.symlink': '不跟随符号链接',
    'theme.problem.size': '文件超过 8 KB',
    'theme.problem.json': '文件不是合法的 JSON',
    'theme.problem.shape': '文件必须是 JSON 对象，其中 "tones" 是颜色对象',
    'theme.problem.unknownKey': '未知的键 "{detail}"',
    'theme.problem.badValue': '"{detail}" 必须是 #rrggbb 形式的颜色',
    'theme.problem.extends': '"extends" 必须是 "dark" 或 "light"',
  },
}
