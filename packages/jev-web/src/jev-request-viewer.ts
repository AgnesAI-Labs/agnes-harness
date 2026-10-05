import type { TraceEntry } from '@agnes/jev-trace'

type SavedRequest = {
  key: string
  seq: number
  label: string
  metadata: string
  raw?: string
  unavailable?: string
}

function savedRequests(entries: readonly TraceEntry[]): SavedRequest[] {
  return entries.flatMap((entry) => {
    const record = entry.record
    if (record.kind !== 'model.requested' || record.call.purpose !== 'decision') return []
    const settlement = entries.find(
      (candidate) =>
        candidate.seq > entry.seq &&
        candidate.record.kind === 'model.settled' &&
        candidate.record.requested === record.id,
    )?.record
    const status =
      settlement?.kind === 'model.settled' ? (settlement.settlement.error ? '失败' : '已结算') : '未结算'
    const result: SavedRequest = {
      key: `${entry.seq}:${record.id}`,
      seq: entry.seq,
      label: `#${entry.seq} · 第 ${entry.turn} 轮 · 步 ${entry.step ?? '未知'} · ${status}`,
      metadata: `endpoint: ${record.call.endpoint}\nrequest ID: ${record.id}\ncodec: ${record.call.codec}\n状态: ${status}`,
    }
    if (record.call.codec !== 'systemone-json-v1') {
      result.unavailable = '未知：此请求使用尚不支持的 codec，不能推断实际请求体。'
      return [result]
    }
    const input = record.call.input
    if (
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.model !== 'string' ||
      !Object.hasOwn(input, 'state') ||
      input.questions === null ||
      typeof input.questions !== 'object' ||
      Array.isArray(input.questions)
    ) {
      result.unavailable = '未知：此记录未保存完整实际请求体，不能从决策或上下文重建。'
      return [result]
    }
    try {
      result.raw = JSON.stringify(input)
    } catch {
      result.unavailable = '未知：保存的请求体无法读取为 JSON。'
    }
    return [result]
  })
}

/** Read only trusted runtime records supplied by the graph, already restricted to its visible prefix. */
export function createJevRequestViewer() {
  const dialog = document.createElement('dialog')
  dialog.className = 'jev-request-viewer'
  dialog.setAttribute('aria-label', 'Jev 实际请求体')
  const header = document.createElement('header')
  const title = document.createElement('h2')
  title.textContent = 'Jev 实际请求体'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '关闭'
  header.append(title, close)
  const note = document.createElement('p')
  note.textContent = '展示已保存的请求准备记录；该记录本身不证明请求已发送或送达。'
  const controls = document.createElement('div')
  controls.className = 'jev-request-viewer-controls'
  const requests = document.createElement('select')
  requests.setAttribute('aria-label', '已保存的 Jev 请求')
  const format = document.createElement('select')
  format.setAttribute('aria-label', 'JSON 显示格式')
  for (const [value, text] of [
    ['pretty', '格式化 JSON'],
    ['raw', '紧凑 JSON'],
  ] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = text
    format.append(option)
  }
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = '复制完整 JSON'
  const download = document.createElement('button')
  download.type = 'button'
  download.textContent = '下载 JSON'
  controls.append(requests, format, copy, download)
  const metadata = document.createElement('pre')
  metadata.className = 'jev-request-viewer-metadata'
  const body = document.createElement('textarea')
  body.className = 'jev-request-viewer-body'
  body.setAttribute('aria-label', '完整 Jev 请求体 JSON')
  body.readOnly = true
  body.spellcheck = false
  const status = document.createElement('p')
  status.className = 'jev-request-viewer-status'
  status.setAttribute('role', 'status')
  dialog.append(header, note, controls, metadata, body, status)
  document.body.append(dialog)
  let choices: SavedRequest[] = []
  let selected: string | undefined
  let disposed = false
  let revision = 0
  let optionsIdentity = ''
  let url: string | undefined
  let revokeTimer: ReturnType<typeof setTimeout> | undefined
  const current = () => choices.find((choice) => choice.key === selected)
  const releaseDownload = () => {
    if (revokeTimer !== undefined) clearTimeout(revokeTimer)
    revokeTimer = undefined
    if (url !== undefined) URL.revokeObjectURL(url)
    url = undefined
  }
  function render() {
    revision++
    releaseDownload()
    const value = current()
    const identity = JSON.stringify([!!value, choices.map(({ key, label }) => [key, label])])
    if (identity !== optionsIdentity) {
      optionsIdentity = identity
      requests.replaceChildren()
      if (!value) {
        const empty = document.createElement('option')
        empty.value = ''
        empty.textContent = '请选择当前可见的请求'
        requests.append(empty)
      }
      for (const choice of choices) {
        const option = document.createElement('option')
        option.value = choice.key
        option.textContent = choice.label
        requests.append(option)
      }
    }
    requests.value = value?.key ?? ''
    requests.disabled = choices.length === 0
    status.textContent =
      choices.length === 0
        ? '当前可见历史中没有已保存的 Jev 决策请求。'
        : (value?.unavailable ?? (value ? '' : '先前请求已退出当前可见历史，请重新选择。'))
    metadata.textContent = value?.metadata ?? ''
    const text =
      value?.raw === undefined
        ? ''
        : format.value === 'raw'
          ? value.raw
          : JSON.stringify(JSON.parse(value.raw), null, 2)
    // Repeated graph updates must not reset the reader's text selection or scroll position.
    if (body.value !== text) body.value = text
    copy.disabled = value?.raw === undefined
    download.disabled = value?.raw === undefined
    format.disabled = value?.raw === undefined
  }
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    if (dialog.open) return
    choices = []
    selected = undefined
    render()
  })
  requests.addEventListener('change', () => {
    selected = requests.value
    render()
  })
  format.addEventListener('change', render)
  copy.addEventListener('click', async () => {
    const raw = current()?.raw
    if (disposed || !dialog.open || raw === undefined) return
    const ticket = revision
    try {
      await navigator.clipboard.writeText(raw)
      if (!disposed && dialog.open && revision === ticket) status.textContent = '已复制完整请求体 JSON。'
    } catch {
      if (!disposed && dialog.open && revision === ticket)
        status.textContent = '复制失败，可在文本框中全选复制或下载 JSON。'
    }
  })
  download.addEventListener('click', () => {
    const value = current()
    if (disposed || !dialog.open || value?.raw === undefined) return
    releaseDownload()
    try {
      url = URL.createObjectURL(new Blob([value.raw], { type: 'application/json;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `jev-request-${value.seq}.json`
      dialog.append(link)
      try {
        link.click()
      } finally {
        link.remove()
      }
      revokeTimer = setTimeout(releaseDownload, 0)
    } catch {
      releaseDownload()
      status.textContent = '下载失败，可复制完整 JSON。'
    }
  })
  render()
  return {
    open(entries: readonly TraceEntry[], selectedSeq?: number) {
      if (disposed) return
      choices = savedRequests(entries)
      selected = (
        selectedSeq === undefined ? choices.at(-1) : choices.find((choice) => choice.seq === selectedSeq)
      )?.key
      format.value = 'pretty'
      render()
      if (!dialog.open) dialog.showModal()
    },
    update(entries: readonly TraceEntry[]) {
      if (disposed) return
      choices = dialog.open ? savedRequests(entries) : []
      if (!current()) selected = undefined
      render()
    },
    dispose() {
      if (disposed) return
      disposed = true
      choices = []
      selected = undefined
      render()
      if (dialog.open) dialog.close()
      dialog.remove()
    },
  }
}
