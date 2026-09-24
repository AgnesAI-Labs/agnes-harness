/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DiagnosticsWarning } from '@agnes/web-units'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollectedDiagnostics, collectDiagnostics } from '../src/diagnostics-bundle.js'
import { createDiagnosticsDialog, type DiagnosticsDialogDeps, saveZip } from '../src/diagnostics-dialog.js'

const FILE = 'agh-diagnostics-abc123DE-20260924-010203.zip'

function collected(warnings: DiagnosticsWarning[] = []): CollectedDiagnostics {
  return {
    bundle: {
      bundleVersion: 1,
      createdAt: '2026-09-24T01:02:03.000Z',
      product: 'agh',
      version: 'test',
      sessionId: 's1',
      sessionTitle: null,
      include: { conversation: true, logs: true, system: true },
      artifacts: [],
      warnings,
    },
    fileName: FILE,
    zip: new Uint8Array(2048),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let ui: ReturnType<typeof createDiagnosticsDialog> | undefined

function setup(sessionId: string | null = 's1', over: Partial<DiagnosticsDialogDeps> = {}) {
  const collect = vi.fn<typeof collectDiagnostics>()
  const save = vi.fn<(zip: Uint8Array, fileName: string) => Promise<'saved' | 'canceled'>>()
  ui = createDiagnosticsDialog({
    call: vi.fn(),
    context: () => ({ sessionId, sessionTitle: null, projection: undefined }),
    collect,
    save,
    ...over,
  })
  const dialog = document.querySelector('dialog.diagnostics-dialog') as HTMLDialogElement
  const visible = () => [...dialog.querySelectorAll('section')].find((s) => !s.hidden)
  const button = (label: string) =>
    [...(visible()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === label,
    ) as HTMLButtonElement
  const box = (name: string) => dialog.querySelector(`input[name="${name}"]`) as HTMLInputElement
  return {
    collect,
    save,
    dialog,
    step: () => visible()?.dataset.step,
    heading: () => dialog.querySelector('h2')?.textContent,
    error: () => dialog.querySelector('.dialog-error')?.textContent ?? '',
    button,
    box,
  }
}

async function toReady(t: ReturnType<typeof setup>, result = collected()) {
  t.collect.mockResolvedValue(result)
  ui?.open()
  t.button('分享诊断').click()
  t.button('生成诊断包').click()
  await flush()
  expect(t.step()).toBe('ready')
}

afterEach(() => {
  ui?.dispose()
  ui = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('createDiagnosticsDialog', () => {
  it('opens on the menu step', () => {
    const t = setup()
    ui?.open()
    expect(t.dialog.open).toBe(true)
    expect(t.dialog.dataset.agnesRegion).toBe('dialog')
    expect(t.step()).toBe('menu')
    expect(t.heading()).toBe('报告问题')
    expect(t.dialog.textContent).toContain('分享前会先对密钥脱敏。')
  })

  it('share step checks every box by default', () => {
    const t = setup()
    ui?.open()
    t.button('分享诊断').click()
    expect(t.step()).toBe('share')
    expect(t.heading()).toBe('选择要包含的内容')
    const boxes = [...t.dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes).toHaveLength(3)
    expect(boxes.every((b) => b.checked && !b.disabled)).toBe(true)
  })

  it('disables conversation without a session', () => {
    const t = setup(null)
    ui?.open()
    t.button('分享诊断').click()
    expect(t.box('conversation').disabled).toBe(true)
    expect(t.box('conversation').checked).toBe(false)
  })

  it('generates with the checked include set, then shows name and size', async () => {
    const t = setup()
    const pending = deferred<CollectedDiagnostics>()
    t.collect.mockReturnValue(pending.promise)
    ui?.open()
    t.button('分享诊断').click()
    t.box('logs').checked = false
    t.button('生成诊断包').click()
    const busy = t.button('正在生成…')
    expect(busy.disabled).toBe(true)
    expect(t.collect).toHaveBeenCalledTimes(1)
    const [input, include] = t.collect.mock.calls[0] ?? []
    expect(include).toEqual({ conversation: true, logs: false, system: true })
    expect(input?.sessionId).toBe('s1')
    expect(input?.browser).toEqual(
      expect.objectContaining({ origin: location.origin, screen: expect.any(Object) }),
    )
    expect(Object.keys(input?.browser ?? {}).sort()).toEqual(
      ['language', 'origin', 'platform', 'screen', 'timeZone', 'userAgent'].sort(),
    )
    pending.resolve(collected())
    await flush()
    expect(t.step()).toBe('ready')
    expect(t.heading()).toBe('诊断包已生成')
    expect(t.dialog.textContent).toContain(FILE)
    expect(t.dialog.textContent).toContain('2 KB')
    expect(t.dialog.querySelector<HTMLElement>('[data-ready-warning]')?.hidden).toBe(true)
  })

  it('ready step shows the warning line when warnings exist', async () => {
    const t = setup()
    await toReady(t, collected([{ source: 'diagnostics.events', reason: 'unavailable' }]))
    const line = t.dialog.querySelector<HTMLElement>('[data-ready-warning]')
    expect(line?.hidden).toBe(false)
    expect(line?.textContent).toContain('diagnostic-export-warnings.json')
  })

  it('saved step title depends on warnings', async () => {
    const t = setup()
    t.save.mockResolvedValue('saved')
    await toReady(t)
    t.button('保存 ZIP 包').click()
    expect(t.save).toHaveBeenCalledWith(expect.any(Uint8Array), FILE)
    await flush()
    expect(t.step()).toBe('saved')
    expect(t.heading()).toBe('诊断文件已保存')
    expect(t.dialog.textContent).toContain(FILE)

    await toReady(t, collected([{ source: 'x', reason: 'failed' }]))
    t.button('保存 ZIP 包').click()
    await flush()
    expect(t.heading()).toBe('问题包已导出，部分资料不完整')
  })

  it('stays on ready without an error when the picker is canceled', async () => {
    const t = setup()
    t.save.mockResolvedValue('canceled')
    await toReady(t)
    t.button('保存 ZIP 包').click()
    await flush()
    expect(t.step()).toBe('ready')
    expect(t.error()).toBe('')
  })

  it('reports a save failure and allows a retry', async () => {
    const t = setup()
    t.save.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce('saved')
    await toReady(t)
    t.button('保存 ZIP 包').click()
    await flush()
    expect(t.error()).toBe('保存诊断分享包失败：disk full')
    expect(t.step()).toBe('ready')
    expect(t.button('保存 ZIP 包').disabled).toBe(false)
    t.button('保存 ZIP 包').click()
    await flush()
    expect(t.save).toHaveBeenCalledTimes(2)
    expect(t.step()).toBe('saved')
  })

  it('reports a generation failure and re-enables the button', async () => {
    const t = setup()
    t.collect.mockRejectedValue(new Error('boom'))
    ui?.open()
    t.button('分享诊断').click()
    t.button('生成诊断包').click()
    await flush()
    expect(t.error()).toBe('生成诊断包失败：boom')
    expect(t.step()).toBe('share')
    expect(t.button('生成诊断包').disabled).toBe(false)
  })

  it('cancel during generation aborts and discards the late result', async () => {
    const t = setup()
    const pending = deferred<CollectedDiagnostics>()
    t.collect.mockReturnValue(pending.promise)
    ui?.open()
    t.button('分享诊断').click()
    t.button('生成诊断包').click()
    t.dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(t.dialog.open).toBe(false)
    expect(t.collect.mock.calls[0]?.[2].aborted).toBe(true)
    pending.resolve(collected())
    await flush()
    expect(t.step()).not.toBe('ready')
    ui?.open()
    expect(t.step()).toBe('menu')
  })

  it('releases the generated ZIP when the dialog closes', async () => {
    const t = setup()
    t.save.mockResolvedValue('saved')
    await toReady(t)
    t.button('保存 ZIP 包').click()
    await flush()
    expect(t.step()).toBe('saved')
    t.button('关闭').click()
    expect(t.dialog.open).toBe(false)
    expect(t.dialog.textContent).not.toContain(FILE)
    // The (now hidden) save button can no longer reach the previous result.
    t.dialog.querySelector<HTMLButtonElement>('[data-action="save"]')?.click()
    await flush()
    expect(t.save).toHaveBeenCalledTimes(1)
    ui?.open()
    expect(t.step()).toBe('menu')
  })

  it('treats only clicks on the dialog element itself as backdrop clicks', () => {
    const t = setup()
    t.collect.mockReturnValue(new Promise(() => {}))
    ui?.open()
    t.button('分享诊断').click()
    t.button('生成诊断包').click()
    const body = t.dialog.querySelector('.diagnostics-body')
    expect(body).not.toBeNull()
    expect([...t.dialog.children]).toEqual([body])
    const inner = [body, t.dialog.querySelector('section:not([hidden])'), t.dialog.querySelector('h2')]
    for (const target of inner) target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(t.dialog.open).toBe(true)
    expect(t.collect.mock.calls[0]?.[2].aborted).toBe(false)
    t.dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(t.dialog.open).toBe(false)
    expect(t.collect.mock.calls[0]?.[2].aborted).toBe(true)
  })

  it('keeps padding off the <dialog> so its own box is only the backdrop edge', () => {
    const css = readFileSync(resolve(__dirname, '../public/style.css'), 'utf8')
    const rule = (selector: string) =>
      new RegExp(`^${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'm').exec(css)?.[1]
    expect(rule('.diagnostics-dialog')).not.toMatch(/padding|margin/)
    expect(rule('.diagnostics-body')).toMatch(/padding/)
    expect(rule('.diagnostics-body')).toMatch(/max-height: var\(--dialog-max-height\)/)
  })

  it('scopes the share step checkboxes to a fixed size instead of the global 100% width', () => {
    const css = readFileSync(resolve(__dirname, '../public/style.css'), 'utf8')
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rule = (selector: string) => new RegExp(`^${escapeRe(selector)} \\{([^}]*)\\}`, 'm').exec(css)?.[1]
    const checkboxRule = rule('.diagnostics-include input[type="checkbox"]')
    expect(checkboxRule).toBeTruthy()
    expect(checkboxRule).not.toMatch(/width:\s*100%/)
    expect(checkboxRule).toMatch(/width:\s*(auto|0|1rem|\d+(\.\d+)?(px|rem|em))\b/)
  })

  it('moves focus to the first enabled control of each step', async () => {
    const t = setup(null)
    t.collect.mockResolvedValue(collected())
    ui?.open()
    t.button('分享诊断').click()
    expect(document.activeElement).toBe(t.box('logs'))
    t.button('生成诊断包').click()
    await flush()
    expect(document.activeElement).toBe(t.button('返回'))
  })

  it('disables the share step back button while generating', async () => {
    const t = setup()
    const pending = deferred<CollectedDiagnostics>()
    t.collect.mockReturnValue(pending.promise)
    ui?.open()
    t.button('分享诊断').click()
    t.button('生成诊断包').click()
    expect(t.button('返回').disabled).toBe(true)
    pending.reject(new Error('boom'))
    await flush()
    expect(t.button('返回').disabled).toBe(false)
  })

  it('returns focus to the trigger on close', () => {
    const t = setup()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    ui?.open(trigger)
    t.button('取消').click()
    expect(t.dialog.open).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })
})

type Writable = {
  write: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
}

function pickerWindow(
  writable: Writable,
  picker = vi.fn(async () => ({ name: FILE, createWritable: async () => writable })),
) {
  return { win: { showSaveFilePicker: picker } as unknown as Window, picker }
}

describe('saveZip', () => {
  const zip = new Uint8Array([1, 2, 3])

  it('writes through showSaveFilePicker', async () => {
    const writable = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    }
    const { win, picker } = pickerWindow(writable)
    await expect(saveZip(zip, FILE, win)).resolves.toBe('saved')
    expect(picker).toHaveBeenCalledWith({
      suggestedName: FILE,
      types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }],
    })
    expect((writable.write.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Blob)
    expect(writable.close).toHaveBeenCalledTimes(1)
    expect(writable.abort).not.toHaveBeenCalled()
  })

  it('calls showSaveFilePicker synchronously, inside the click activation', () => {
    const writable = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    }
    const { win, picker } = pickerWindow(writable)
    void saveZip(zip, FILE, win)
    expect(picker).toHaveBeenCalledTimes(1)
  })

  it('returns canceled when the picker is dismissed', async () => {
    const writable = { write: vi.fn(), close: vi.fn(), abort: vi.fn() }
    const picker = vi.fn(async () => {
      throw new DOMException('dismissed', 'AbortError')
    })
    const { win } = pickerWindow(writable, picker as never)
    await expect(saveZip(zip, FILE, win)).resolves.toBe('canceled')
  })

  it('aborts the writable and rethrows when writing fails', async () => {
    const order: string[] = []
    const writable = {
      write: vi.fn(async () => {
        throw new Error('quota')
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {
        order.push('abort')
      }),
    }
    const { win } = pickerWindow(writable)
    await expect(saveZip(zip, FILE, win)).rejects.toThrow('quota')
    expect(order).toEqual(['abort'])
    expect(writable.close).not.toHaveBeenCalled()
  })

  it('falls back to an <a download> without showSaveFilePicker', async () => {
    vi.useFakeTimers()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:diagnostics')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let clicked: HTMLAnchorElement | undefined
    let attached = false
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this
      attached = this.isConnected
    })
    await expect(saveZip(zip, FILE, window)).resolves.toBe('saved')
    expect(create).toHaveBeenCalledTimes(1)
    expect(clicked?.download).toBe(FILE)
    expect(clicked?.href).toBe('blob:diagnostics')
    expect(attached).toBe(true)
    expect(clicked?.isConnected).toBe(false)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(revoke).toHaveBeenCalledWith('blob:diagnostics')
  })
})
