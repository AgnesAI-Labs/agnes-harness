import { describe, expect, it, vi } from 'vitest'
import { createNativeWorkspacePicker, type PickerCommandRunner } from '../launch/workspace-picker.js'

describe('native workspace picker locale prompts', () => {
  it.each(['darwin', 'win32'] as const)(
    'interpolates the translated prompt into the %s script',
    async (platform) => {
      let args: readonly string[] = []
      const run: PickerCommandRunner = vi.fn(async (_executable, commandArgs) => {
        args = commandArgs
        return { exitCode: 0, stdout: platform === 'darwin' ? 'cancelled' : '{"status":"cancelled"}' }
      })
      const picker = createNativeWorkspacePicker({
        platform,
        env: { AGNES_LOCALE: 'zh-CN', PATH: '/bin', SystemRoot: 'C:\\Windows' },
        findExecutable: async () => 'picker',
        run,
      })

      expect(await picker.pick(new AbortController().signal)).toEqual({ status: 'cancelled' })
      const script =
        platform === 'darwin' ? args[1] : Buffer.from(args[5] ?? '', 'base64').toString('utf16le')
      expect(script).toContain('选择 Agnes 工作区')
      expect(script).not.toContain('TITLE()')
      // 提示语必须是合法的字符串字面量：缺引号会让 AppleScript 编译失败，PowerShell 则把它当成命令调用。
      expect(script).toContain(
        platform === 'darwin'
          ? 'choose folder with prompt "选择 Agnes 工作区"'
          : "$dialog.Description = '选择 Agnes 工作区'",
      )
    },
  )
})
