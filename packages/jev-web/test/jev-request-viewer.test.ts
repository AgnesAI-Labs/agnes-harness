/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import type { TraceEntry } from '@agnes/jev-trace'
import { afterEach, expect, it, vi } from 'vitest'
import { createJevTranslate } from '../src/jev-locale.js'
import { createJevRequestViewer } from '../src/jev-request-viewer.js'

const t = createJevTranslate('zh-CN')

const viewers: ReturnType<typeof createJevRequestViewer>[] = []
function viewer() {
  const result = createJevRequestViewer(t)
  viewers.push(result)
  return result
}
function request(seq: number, input: unknown, codec = 'systemone-json-v1', purpose = 'decision'): TraceEntry {
  return {
    seq,
    time: seq,
    turn: 2,
    step: 3,
    record: {
      version: 1,
      kind: 'model.requested',
      id: `request-${seq}`,
      turn: 'turn',
      step: 'step',
      call: {
        purpose,
        codec,
        input,
        endpoint: 'https://synthetic.invalid/decision',
        requestedModel: 'test',
        backend: 'jev',
        inputCursor: '0',
      },
    },
  } as unknown as TraceEntry
}
const payload = () => ({ model: 'test', state: { text: '保存的状态' }, questions: {} })
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.jev-request-viewer button')].find(
    (item) => item.textContent === text,
  )
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
function body(): HTMLTextAreaElement {
  const found = document.querySelector<HTMLTextAreaElement>('.jev-request-viewer-body')
  if (!found) throw new Error('Missing request body')
  return found
}
afterEach(() => {
  for (const item of viewers.splice(0)) item.dispose()
  document.querySelector('[data-jev-request-test-styles]')?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('shows and copies the full saved HTTP body beyond 24k without the record wrapper', async () => {
  const styles = document.createElement('style')
  styles.dataset.jevRequestTestStyles = ''
  styles.textContent = ['packages/web/public/style.css', 'packages/jev-web/styles/jev-graph.css']
    .map((name) => readFileSync(name, 'utf8'))
    .join('\n')
  document.body.append(styles)
  const input = {
    ...payload(),
    state: { text: `${'x'.repeat(30_000)}完整尾部</textarea><script>not executable</script>` },
  }
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const component = viewer()
  component.open([request(7, input)])
  // The JSON reader fills its dialog, unlike the globally height-capped prompt textarea.
  expect(getComputedStyle(body()).maxHeight).toBe('none')
  expect(body().readOnly).toBe(true)
  expect(JSON.parse(body().value)).toEqual(input)
  expect(body().value).toContain('完整尾部')
  body().setSelectionRange(30, 80)
  component.update([request(7, input)])
  expect([body().selectionStart, body().selectionEnd]).toEqual([30, 80])
  expect(document.querySelector('.jev-request-viewer script')).toBeNull()
  expect(body().value).not.toContain('inputCursor')
  expect(document.querySelector('.jev-request-viewer-metadata')?.textContent).toContain('request-7')
  expect(document.querySelector('.jev-request-viewer-metadata')?.textContent).toContain('未结算')
  component.update([
    request(7, input),
    {
      seq: 8,
      time: 8,
      turn: 2,
      step: 3,
      record: {
        kind: 'model.settled',
        version: 1,
        id: 'settled',
        turn: 'turn',
        requested: 'request-7',
        settlement: { output: {} },
      },
    } as unknown as TraceEntry,
  ])
  expect(document.querySelector('.jev-request-viewer-metadata')?.textContent).toContain('已结算')
  expect(document.querySelector('.jev-request-viewer')?.textContent).toContain('不证明请求已发送或送达')
  const format = document.querySelector<HTMLSelectElement>('[aria-label="JSON 显示格式"]')
  if (!format) throw new Error('Missing format selector')
  format.value = 'raw'
  format.dispatchEvent(new Event('change'))
  expect(body().value).toBe(JSON.stringify(input))
  button('复制完整 JSON').click()
  await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(JSON.stringify(input)))
})

it('retires an invisible selection immediately and ignores a late clipboard completion', async () => {
  let finish!: () => void
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const first = request(1, payload())
  const second = request(5, { ...payload(), model: 'later-model' })
  const component = viewer()
  component.open([first, second], 5)
  button('复制完整 JSON').click()
  component.update([first])
  expect(body().value).toBe('')
  expect(document.querySelector('.jev-request-viewer-metadata')?.textContent).toBe('')
  expect(button('复制完整 JSON').disabled).toBe(true)
  expect(button('下载 JSON').disabled).toBe(true)
  button('复制完整 JSON').click()
  finish()
  await Promise.resolve()
  expect(copy).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="status"]')?.textContent).toContain('退出当前可见历史')
  const select = document.querySelector<HTMLSelectElement>('[aria-label="已保存的决策请求"]')
  if (!select) throw new Error('Missing request selector')
  select.value = '1:request-1'
  select.dispatchEvent(new Event('change'))
  expect(JSON.parse(body().value)).toEqual(payload())
  component.update([])
  expect(body().value).toBe('')
  expect(button('复制完整 JSON').disabled).toBe(true)
})

it.each([
  ['new-codec', payload(), 'codec'],
  ['systemone-json-v1', undefined, '未保存完整实际请求体'],
  ['systemone-json-v1', null, '未保存完整实际请求体'],
  ['systemone-json-v1', { state: 'not a prepared body' }, '未保存完整实际请求体'],
])('keeps unavailable bodies unknown for %s', (codec, input, explanation) => {
  viewer().open([request(1, payload(), 'systemone-json-v1', 'answer'), request(2, input, codec)])
  expect(body().value).toBe('')
  expect(button('复制完整 JSON').disabled).toBe(true)
  expect(button('下载 JSON').disabled).toBe(true)
  expect(document.querySelector('[role="status"]')?.textContent).toContain(explanation)
  expect(document.querySelector('[aria-label="已保存的决策请求"]')?.children).toHaveLength(1)
})

it('downloads only the complete request body and revokes its URL on history retirement and dispose', async () => {
  vi.useFakeTimers()
  const createURL = vi.fn((_blob: Blob) => 'blob:request')
  const revokeURL = vi.fn()
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = createURL
      static override revokeObjectURL = revokeURL
    },
  )
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const input = { ...payload(), state: { tail: `${'y'.repeat(25_000)}END` } }
  const component = viewer()
  component.open([request(9, input)])
  button('下载 JSON').click()
  const blob = createURL.mock.calls[0]?.[0] as Blob | undefined
  if (!blob) throw new Error('Missing download blob')
  expect(await blob.text()).toBe(JSON.stringify(input))
  expect(click).toHaveBeenCalledOnce()
  expect(document.querySelector('.jev-request-viewer a')).toBeNull()
  component.update([])
  expect(revokeURL).toHaveBeenCalledWith('blob:request')
  expect(vi.getTimerCount()).toBe(0)
  component.open([request(9, input)])
  button('下载 JSON').click()
  button('关闭').click()
  await vi.waitFor(() => expect(revokeURL).toHaveBeenCalledTimes(2))
  expect(body().value).toBe('')
  component.open([request(9, input)])
  button('下载 JSON').click()
  component.dispose()
  expect(document.querySelector('.jev-request-viewer')).toBeNull()
  expect(revokeURL).toHaveBeenCalledTimes(3)
})
