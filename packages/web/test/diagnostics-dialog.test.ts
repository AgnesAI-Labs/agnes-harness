/** @vitest-environment happy-dom */
import { resolve } from 'node:path'
import type { DiagnosticsWarning } from '@agnes/web-units'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
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
  const save = vi.fn<NonNullable<DiagnosticsDialogDeps['save']>>()
  ui = createDiagnosticsDialog({
    call: vi.fn(),
    context: () => ({ sessionId, sessionTitle: null, projection: undefined, projectionHasEarlier: false }),
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
  t.button('Share diagnostics').click()
  t.button('Generate package').click()
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
    expect(t.heading()).toBe('Report a problem')
    expect(t.dialog.textContent).toContain('Secrets are redacted before sharing.')
  })

  it('share step checks every box by default', () => {
    const t = setup()
    ui?.open()
    t.button('Share diagnostics').click()
    expect(t.step()).toBe('share')
    expect(t.heading()).toBe('Choose what to include')
    const boxes = [...t.dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes).toHaveLength(3)
    expect(boxes.every((b) => b.checked && !b.disabled)).toBe(true)
  })

  it('disables conversation without a session', () => {
    const t = setup(null)
    ui?.open()
    t.button('Share diagnostics').click()
    expect(t.box('conversation').disabled).toBe(true)
    expect(t.box('conversation').checked).toBe(false)
  })

  it('returns through all four steps without losing the selected options', async () => {
    const t = setup()
    t.collect.mockResolvedValue(collected())
    t.save.mockResolvedValue('saved')
    ui?.open()
    t.button('Share diagnostics').click()
    t.box('logs').click()
    t.button('Back').click()
    expect(t.step()).toBe('menu')
    t.button('Share diagnostics').click()
    expect(t.box('logs').checked).toBe(false)
    t.button('Generate package').click()
    await flush()
    t.button('Back').click()
    expect(t.step()).toBe('share')
    t.button('Generate package').click()
    await flush()
    t.button('Save ZIP').click()
    await flush()
    expect(t.step()).toBe('saved')
  })

  it('generates with the checked include set, then shows name and size', async () => {
    const t = setup()
    const pending = deferred<CollectedDiagnostics>()
    t.collect.mockReturnValue(pending.promise)
    ui?.open()
    t.button('Share diagnostics').click()
    t.box('logs').click()
    t.button('Generate package').click()
    const busy = t.button('Generating…')
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
    expect(t.heading()).toBe('Diagnostics package is ready')
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
    t.button('Save ZIP').click()
    expect(t.save).toHaveBeenCalledWith(expect.any(Uint8Array), FILE)
    await flush()
    expect(t.step()).toBe('saved')
    expect(t.heading()).toBe('Diagnostics file saved')
    expect(t.dialog.textContent).toContain(FILE)

    await toReady(t, collected([{ source: 'x', reason: 'failed' }]))
    t.button('Save ZIP').click()
    await flush()
    expect(t.heading()).toBe('The package was exported, but some material is incomplete')
  })

  it('stays on ready without an error when the picker is canceled', async () => {
    const t = setup()
    t.save.mockResolvedValue('canceled')
    await toReady(t)
    t.button('Save ZIP').click()
    await flush()
    expect(t.step()).toBe('ready')
    expect(t.error()).toBe('')
  })

  it('shows the download request and lets the same ZIP be retried without duplicate clicks', async () => {
    const t = setup()
    const result = collected([{ source: 'diagnostics.events', reason: 'unavailable' }])
    t.save.mockResolvedValue('download-requested')
    await toReady(t, result)
    t.button('Save ZIP').click()
    await flush()

    expect(t.step()).toBe('download-requested')
    expect(t.heading()).toBe('Download requested')
    expect(document.activeElement).toBe(t.dialog.querySelector('h2'))
    expect(t.dialog.querySelector<HTMLElement>('[data-ready-warning]')?.hidden).toBe(false)
    expect(t.dialog.querySelector<HTMLElement>('[data-ready-summary]')?.textContent).toContain(FILE)
    expect(t.error()).toBe('')

    const retry = t.button('Download again')
    const secondClick = () => retry.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
    secondClick()
    expect(t.save).toHaveBeenCalledTimes(1)
    retry.click()
    expect(retry.disabled).toBe(true)
    await flush()
    secondClick()
    expect(t.save.mock.calls).toEqual([
      [result.zip, FILE],
      [result.zip, FILE],
    ])
    expect(t.collect).toHaveBeenCalledTimes(1)
    expect(retry.disabled).toBe(false)
    expect(t.step()).toBe('download-requested')
  })

  it('reports a save failure and allows a retry', async () => {
    const t = setup()
    t.save.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce('saved')
    await toReady(t)
    t.button('Save ZIP').click()
    await flush()
    expect(t.error()).toBe('Could not save the diagnostics package: disk full')
    expect(t.step()).toBe('ready')
    expect(t.button('Save ZIP').disabled).toBe(false)
    t.button('Save ZIP').click()
    await flush()
    expect(t.save).toHaveBeenCalledTimes(2)
    expect(t.step()).toBe('saved')
  })

  it('reports a generation failure and re-enables the button', async () => {
    const t = setup()
    t.collect.mockRejectedValue(new Error('boom'))
    ui?.open()
    t.button('Share diagnostics').click()
    t.button('Generate package').click()
    await flush()
    expect(t.error()).toBe('Could not generate the diagnostics package: boom')
    expect(t.step()).toBe('share')
    expect(t.button('Generate package').disabled).toBe(false)
  })

  it('cancel during generation aborts and discards the late result', async () => {
    const t = setup()
    const pending = deferred<CollectedDiagnostics>()
    t.collect.mockReturnValue(pending.promise)
    ui?.open()
    t.button('Share diagnostics').click()
    t.button('Generate package').click()
    t.dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(t.dialog.open).toBe(false)
    expect(t.collect.mock.calls[0]?.[2].aborted).toBe(true)
    pending.resolve(collected())
    await flush()
    expect(t.step()).not.toBe('ready')
    ui?.open()
    expect(t.step()).toBe('menu')
  })

  it('ignores a late generation failure after closing and reopening', async () => {
    const t = setup()
    const pending = deferred<CollectedDiagnostics>()
    t.collect.mockReturnValue(pending.promise)
    ui?.open()
    t.button('Share diagnostics').click()
    t.button('Generate package').click()
    t.dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    ui?.open()
    pending.reject(new Error('late failure'))
    await flush()
    expect(t.step()).toBe('menu')
    expect(t.error()).toBe('')
  })

  it('retires an in-flight collection on disposal without repainting its detached dialog', async () => {
    const t = setup()
    const pending = deferred<CollectedDiagnostics>()
    t.collect.mockReturnValue(pending.promise)
    ui?.open()
    t.button('Share diagnostics').click()
    t.button('Generate package').click()
    ui?.dispose()
    expect(t.dialog.isConnected).toBe(false)
    expect(t.collect.mock.calls[0]?.[2].aborted).toBe(true)
    pending.resolve(collected())
    await flush()
    expect(t.dialog.querySelector('[data-ready-summary]')).toBeNull()
    ui?.open()
    expect(t.dialog.isConnected).toBe(false)
  })

  it('releases a ready ZIP on disposal so detached controls cannot save it', async () => {
    const t = setup()
    t.save.mockResolvedValue('saved')
    await toReady(t)
    ui?.dispose()
    t.dialog.querySelector<HTMLButtonElement>('[data-action="save"]')?.click()
    await flush()
    expect(t.save).not.toHaveBeenCalled()
    expect(t.dialog.querySelector('[data-ready-summary]')).toBeNull()
  })

  it.each(['saved', 'download-requested'] as const)('releases the ZIP after %s', async (outcome) => {
    const t = setup()
    t.save.mockResolvedValue(outcome)
    await toReady(t)
    t.button('Save ZIP').click()
    await flush()
    expect(t.step()).toBe(outcome)
    t.button('Close').click()
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
    t.button('Share diagnostics').click()
    t.button('Generate package').click()
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
    const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))
    const rule = (selector: string) =>
      new RegExp(`^\\s*${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'm').exec(css)?.[1]
    expect(rule('.diagnostics-dialog')).not.toMatch(/padding|margin/)
    expect(rule('.diagnostics-body')).toMatch(/padding/)
    expect(rule('.diagnostics-body')).toMatch(/max-height: var\(--dialog-max-height\)/)
  })

  it('scopes the share step checkboxes to a fixed size instead of the global 100% width', () => {
    const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rule = (selector: string) =>
      new RegExp(`^\\s*${escapeRe(selector)} \\{([^}]*)\\}`, 'm').exec(css)?.[1]
    const checkboxRule = rule('.diagnostics-include input[type="checkbox"]')
    expect(checkboxRule).toBeTruthy()
    expect(checkboxRule).not.toMatch(/width:\s*100%/)
    expect(checkboxRule).toMatch(/width:\s*(auto|0|1rem|\d+(\.\d+)?(px|rem|em))\b/)
  })

  it('moves focus to the first enabled control of each step', async () => {
    const t = setup(null)
    t.collect.mockResolvedValue(collected())
    ui?.open()
    t.button('Share diagnostics').click()
    expect(document.activeElement).toBe(t.box('logs'))
    t.button('Generate package').click()
    await flush()
    expect(document.activeElement).toBe(t.button('Back'))
  })

  it('disables the share step back button while generating', async () => {
    const t = setup()
    const pending = deferred<CollectedDiagnostics>()
    t.collect.mockReturnValue(pending.promise)
    ui?.open()
    t.button('Share diagnostics').click()
    t.button('Generate package').click()
    expect(t.button('Back').disabled).toBe(true)
    pending.reject(new Error('boom'))
    await flush()
    expect(t.button('Back').disabled).toBe(false)
  })

  it('returns focus to the trigger on close', () => {
    const t = setup()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    ui?.open(trigger)
    t.button('Cancel').click()
    expect(t.dialog.open).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('starts saving in the click and ignores extra clicks during and after the save', async () => {
    const t = setup()
    await toReady(t)
    const pending = deferred<'saved'>()
    t.save.mockReturnValue(pending.promise)
    const button = t.button('Save ZIP')
    button.click()
    expect(t.save).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    button.click()
    expect(t.save).toHaveBeenCalledTimes(1)
    pending.resolve('saved')
    await flush()
    expect(t.step()).toBe('saved')
    button.click()
    expect(t.save).toHaveBeenCalledTimes(1)
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
  const win = { document, showSaveFilePicker: picker }
  return { win: Object.assign(win, { top: win }) as unknown as Window, picker }
}

describe('saveZip', () => {
  const zip = new Uint8Array([1, 2, 3])

  it.each(['top-level', 'same-origin frame'])('writes through showSaveFilePicker in %s', async (context) => {
    const writable = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    }
    const { win, picker } = pickerWindow(writable)
    if (context === 'same-origin frame') Object.assign(win, { top: window })
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
    const download = vi.spyOn(URL, 'createObjectURL')
    const writable = { write: vi.fn(), close: vi.fn(), abort: vi.fn() }
    const picker = vi.fn(async () => {
      throw new DOMException('dismissed', 'AbortError')
    })
    const { win } = pickerWindow(writable, picker as never)
    await expect(saveZip(zip, FILE, win)).resolves.toBe('canceled')
    expect(download).not.toHaveBeenCalled()
  })

  it('surfaces a top-level picker security error without downloading', async () => {
    const download = vi.spyOn(URL, 'createObjectURL')
    const failure = new DOMException('Missing user activation', 'SecurityError')
    const { win, picker } = pickerWindow({ write: vi.fn(), close: vi.fn(), abort: vi.fn() })
    picker.mockRejectedValue(failure)
    await expect(saveZip(zip, FILE, win)).rejects.toBe(failure)
    expect(download).not.toHaveBeenCalled()
  })

  it.each(['createWritable', 'write', 'close'] as const)(
    'reports a failure from %s without downloading',
    async (stage) => {
      const download = vi.spyOn(URL, 'createObjectURL')
      const failure = new DOMException('Cannot save this file', 'NotAllowedError')
      const writable = {
        write: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
      }
      const { win, picker } = pickerWindow(writable)
      const createWritable = vi.fn(async () => writable)
      picker.mockResolvedValue({ name: FILE, createWritable })
      const failingOperation = stage === 'createWritable' ? createWritable : writable[stage]
      failingOperation.mockRejectedValue(failure)
      await expect(saveZip(zip, FILE, win)).rejects.toBe(failure)
      expect(writable.abort).toHaveBeenCalledTimes(stage === 'createWritable' ? 0 : 1)
      expect(writable.close).toHaveBeenCalledTimes(stage === 'close' ? 1 : 0)
      expect(download).not.toHaveBeenCalled()
    },
  )

  it.each(['without a picker', 'in a cross-origin frame'])('downloads once %s', async (context) => {
    vi.useFakeTimers()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:diagnostics')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let clicked: HTMLAnchorElement | undefined
    let attached = false
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked = this
      attached = this.isConnected
    })
    const { win, picker } = pickerWindow({ write: vi.fn(), close: vi.fn(), abort: vi.fn() })
    const crossOriginTop = {
      get document(): Document {
        throw new DOMException('Cross-origin access denied', 'SecurityError')
      },
    }
    Object.assign(win, { top: crossOriginTop })
    const pending = saveZip(zip, FILE, context === 'in a cross-origin frame' ? win : window)
    expect(click).toHaveBeenCalledTimes(1)
    await expect(pending).resolves.toBe('download-requested')
    expect(picker).not.toHaveBeenCalled()
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
