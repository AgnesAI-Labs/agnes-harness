import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { StringDecoder } from 'node:string_decoder'

// agent-browser 0.39.1's newline-delimited daemon protocol. Never retry a dispatched action.
export function request(endpoint, command, signal, timeoutMs = 30000) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = connect(endpoint)
    const decoder = new StringDecoder('utf8')
    let bytes = 0,
      text = '',
      dispatched = false,
      settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const uncertain = (message) =>
      new Error(
        `${dispatched ? 'BROWSER_OUTCOME_UNKNOWN: do not repeat an action without inspecting the page. ' : ''}${message}`,
      )
    const abort = () => finish(uncertain('Browser request cancelled'))
    const timer = setTimeout(() => finish(uncertain('Browser request timed out')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    socket.on('error', (error) => finish(uncertain(error.message)))
    socket.on('end', () => finish(uncertain('Browser connection closed')))
    socket.on('connect', () => {
      if (signal?.aborted) return abort()
      dispatched = true
      socket.write(`${JSON.stringify({ ...command, id })}\n`)
    })
    socket.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) return finish(uncertain('Browser response exceeds 8 MiB'))
      text += decoder.write(chunk)
      const newline = text.indexOf('\n')
      if (newline < 0) return
      let result
      try {
        result = JSON.parse(text.slice(0, newline))
        if (result.id !== id) throw new Error('Browser response identity mismatch')
      } catch (error) {
        return finish(uncertain(error.message))
      }
      if (!result.success)
        return finish(
          new Error(
            `Browser ${command.action}: ${result.code ? `${result.code}: ` : ''}${result.error || 'command failed'}`,
          ),
        )
      finish(undefined, result.data)
    })
  })
}

export function commandFor(input) {
  const selector = () => {
    // Snapshots return refs as eN keys, while CLI examples show @eN. Both name the same
    // owned-page element; never accept arbitrary selectors or command-line options.
    if (typeof input.ref !== 'string' || !/^@?e\d+$/.test(input.ref))
      throw new Error('Expected a browser snapshot element reference such as e1 or @e1')
    return input.ref.startsWith('@') ? input.ref : `@${input.ref}`
  }
  switch (input.action) {
    case 'open': {
      const url = new URL(input.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Only HTTP(S) page URLs without embedded credentials are supported')
      return { action: 'navigate', url: url.href, waitUntil: 'domcontentloaded' }
    }
    case 'snapshot':
      return { action: 'snapshot', interactive: true, compact: true }
    case 'click':
      return { action: 'click', selector: selector() }
    case 'fill':
      if (typeof input.text !== 'string' || input.text.length > 16384)
        throw new Error('Text must be at most 16384 characters')
      return { action: 'fill', selector: selector(), value: input.text }
    case 'press':
      if (typeof input.key !== 'string' || !input.key.length || input.key.length > 80)
        throw new Error('A browser key is required')
      return { action: 'press', key: input.key }
    case 'scroll':
      if (!['up', 'down', 'left', 'right'].includes(input.direction))
        throw new Error('Invalid scroll direction')
      return { action: 'scroll', direction: input.direction, amount: 500 }
    case 'back':
    case 'forward':
    case 'reload':
      return { action: input.action }
    case 'tabs':
      return { action: 'tab_list' }
    case 'tab':
      if (!/^t\d+$/.test(input.tabId ?? '')) throw new Error('Invalid tab identity')
      return { action: 'tab_switch', tabId: input.tabId }
    case 'screenshot':
      return { action: 'screenshot', format: 'png', fullPage: false }
    case 'close':
      return { action: 'close' }
    default:
      throw new Error('Unsupported browser action')
  }
}
