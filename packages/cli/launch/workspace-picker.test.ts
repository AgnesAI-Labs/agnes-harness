import { describe, expect, it, vi } from 'vitest'
import {
  createNativeWorkspacePicker,
  type PickerCommandRunner,
  runPickerCommand,
} from './workspace-picker.js'

describe('native workspace picker', () => {
  it('uses the macOS system picker and decodes selected and cancelled results', async () => {
    const run = vi
      .fn<PickerCommandRunner>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'selected\n/fixture/home/项目\n' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'cancelled\n' })
    const picker = createNativeWorkspacePicker({
      platform: 'darwin',
      env: { HOME: '/fixture/home', DEEPSEEK_API_KEY: 'must-not-leak' },
      run,
      findExecutable: async () => '/usr/bin/osascript',
    })
    expect(await picker.available()).toBe(true)
    await expect(picker.pick(new AbortController().signal)).resolves.toEqual({
      status: 'selected',
      path: '/fixture/home/项目',
    })
    await expect(picker.pick(new AbortController().signal)).resolves.toEqual({ status: 'cancelled' })
    expect(run.mock.calls[0]?.[0]).toBe('/usr/bin/osascript')
    expect(run.mock.calls[0]?.[1].at(-1)).toContain('choose folder')
    expect(run.mock.calls[0]?.[1].at(-1)).toContain('on error number -128')
    expect(run.mock.calls[0]?.[3]).not.toHaveProperty('DEEPSEEK_API_KEY')
  })

  it('uses the Windows STA folder dialog and rejects malformed or relative output', async () => {
    const run = vi
      .fn<PickerCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"status":"selected","path":"C:\\\\work\\\\agnes"}',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"status":"selected","path":"relative"}' })
    const picker = createNativeWorkspacePicker({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', PATH: '' },
      run,
      findExecutable: async (candidates) => candidates[0],
    })
    expect(await picker.available()).toBe(true)
    await expect(picker.pick(new AbortController().signal)).resolves.toEqual({
      status: 'selected',
      path: 'C:\\work\\agnes',
    })
    await expect(picker.pick(new AbortController().signal)).resolves.toEqual({ status: 'unavailable' })
    expect(run.mock.calls[0]?.[1]).toContain('-STA')
    const encodedScript = run.mock.calls[0]?.[1].at(-1)
    expect(Buffer.from(encodedScript ?? '', 'base64').toString('utf16le')).toContain('FolderBrowserDialog')
  })

  it('prefers Zenity, treats its exit 1 as cancel, and falls back to KDialog', async () => {
    const zenityRun = vi.fn<PickerCommandRunner>().mockResolvedValue({ exitCode: 1, stdout: '' })
    const zenity = createNativeWorkspacePicker({
      platform: 'linux',
      env: { DISPLAY: ':0', HOME: '/fixture/home' },
      run: zenityRun,
      findExecutable: async (candidates) => (candidates.includes('zenity') ? '/usr/bin/zenity' : undefined),
    })
    await expect(zenity.pick(new AbortController().signal)).resolves.toEqual({ status: 'cancelled' })
    expect(zenityRun.mock.calls[0]?.[0]).toBe('/usr/bin/zenity')

    const kdialogRun = vi
      .fn<PickerCommandRunner>()
      .mockResolvedValue({ exitCode: 0, stdout: '/fixture/home/工作区\n' })
    const kdialog = createNativeWorkspacePicker({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0', HOME: '/fixture/home' },
      run: kdialogRun,
      findExecutable: async (candidates) => (candidates.includes('kdialog') ? '/usr/bin/kdialog' : undefined),
    })
    await expect(kdialog.pick(new AbortController().signal)).resolves.toEqual({
      status: 'selected',
      path: '/fixture/home/工作区',
    })
    expect(kdialogRun.mock.calls[0]?.[1]).toContain('/fixture/home')
  })

  it('is unavailable without a supported platform, graphical Linux session or picker binary', async () => {
    const missing = async () => undefined
    await expect(
      createNativeWorkspacePicker({ platform: 'freebsd', findExecutable: missing }).available(),
    ).resolves.toBe(false)
    await expect(
      createNativeWorkspacePicker({ platform: 'linux', env: {}, findExecutable: missing }).available(),
    ).resolves.toBe(false)
    await expect(
      createNativeWorkspacePicker({
        platform: 'linux',
        env: { DISPLAY: ':0' },
        findExecutable: missing,
      }).pick(new AbortController().signal),
    ).resolves.toEqual({ status: 'unavailable' })
    await expect(
      createNativeWorkspacePicker({
        platform: 'darwin',
        env: { SSH_CONNECTION: 'client server' },
        findExecutable: async () => '/usr/bin/osascript',
      }).available(),
    ).resolves.toBe(false)
  })

  it('contains command failures and overlong native output', async () => {
    const failing = createNativeWorkspacePicker({
      platform: 'darwin',
      findExecutable: async () => '/usr/bin/osascript',
      run: async () => {
        throw new Error('secret host diagnostic')
      },
    })
    await expect(failing.pick(new AbortController().signal)).resolves.toEqual({ status: 'unavailable' })

    const overlong = createNativeWorkspacePicker({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      findExecutable: async () => '/usr/bin/zenity',
      run: async () => ({ exitCode: 0, stdout: `/${'a'.repeat(4096)}` }),
    })
    await expect(overlong.pick(new AbortController().signal)).resolves.toEqual({ status: 'unavailable' })
  })

  it('terminates the native subprocess when the request is aborted', async () => {
    const controller = new AbortController()
    const pending = runPickerCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      controller.signal,
      { PATH: process.env.PATH },
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
