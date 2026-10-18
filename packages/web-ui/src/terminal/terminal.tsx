import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { terminalDocument } from './document.js'
import { snapshotDelta, terminalPaste } from './snapshot.js'
import { TerminalPalette } from './theme.js'

export type TerminalScreenProps = {
  stdout: string
  stderr: string
  writable: boolean
  label: string
  exitLine?: string | undefined
  exitTone?: string
  onData(text: string): void
  onResize(columns: number, rows: number): void
}

/** UI-only emulator; the session continues to own the PTY after this screen unmounts. */
export function TerminalScreen(props: TerminalScreenProps) {
  const host = useRef<HTMLDivElement>(null)
  const current = useRef(props)
  current.current = props
  const screen = useRef<{ terminal: Terminal; palette: TerminalPalette; fit(): void; blink(): void }>()
  const written = useRef({ stdout: '', stderr: '', exit: '' })
  useLayoutEffect(() => {
    const node = host.current
    if (!node) return
    const terminal = new Terminal({
      documentOverride: terminalDocument(node.ownerDocument),
      screenReaderMode: true,
      cursorBlink: false,
      scrollback: 10000,
      disableStdin: !current.current.writable,
    })
    const addon = new FitAddon()
    terminal.loadAddon(addon)
    terminal.open(node)
    // Preserve the workbench's close and region-navigation shortcuts.
    terminal.attachCustomKeyEventHandler((event) => event.key !== 'Escape' && event.key !== 'F6')
    const palette = new TerminalPalette(terminal)
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const blink = () => {
      terminal.options.cursorBlink =
        node.contains(document.activeElement) && !motion.matches && current.current.writable
    }
    const input = terminal.onData((text) => {
      if (current.current.writable) current.current.onData(text)
    })
    let last = ''
    const fit = () => {
      if (!node.clientWidth || !node.clientHeight) return
      const dimensions = addon.proposeDimensions()
      if (!dimensions) return
      const columns = Math.max(2, Math.min(1000, dimensions.cols)),
        rows = Math.max(1, Math.min(1000, dimensions.rows))
      terminal.resize(columns, rows)
      const size = `${columns}:${rows}`
      if (current.current.writable && last !== size) {
        last = size
        current.current.onResize(columns, rows)
      }
    }
    const theme = () => {
      const style = getComputedStyle(node)
      palette.update(style.backgroundColor, style.color)
      terminal.options.fontFamily = style.fontFamily
      terminal.options.fontSize = parseFloat(style.fontSize) || 13
      fit()
    }
    const paste = (event: ClipboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (current.current.writable)
        current.current.onData(terminalPaste(event.clipboardData?.getData('text/plain') ?? ''))
    }
    node.addEventListener('paste', paste, true)
    node.addEventListener('focusin', blink)
    node.addEventListener('focusout', blink)
    motion.addEventListener('change', blink)
    dark.addEventListener('change', theme)
    const observer = new MutationObserver(theme)
    // Only ancestors supply app/skin tokens; xterm's own DOM mutations must not trigger feedback.
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement)
      observer.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit)
    resize?.observe(node)
    screen.current = { terminal, palette, fit, blink }
    written.current = { stdout: '', stderr: '', exit: '' }
    theme()
    terminal.textarea?.setAttribute('aria-label', current.current.label)
    // Roving tab navigation keeps focus on the selected tab; launching/attaching focuses input.
    if (!node.ownerDocument.activeElement?.closest('[role="tablist"], [role="listbox"], [role="toolbar"]'))
      terminal.focus()
    blink()
    return () => {
      resize?.disconnect()
      observer.disconnect()
      dark.removeEventListener('change', theme)
      motion.removeEventListener('change', blink)
      node.removeEventListener('paste', paste, true)
      node.removeEventListener('focusin', blink)
      node.removeEventListener('focusout', blink)
      input.dispose()
      palette.dispose()
      terminal.dispose()
      screen.current = undefined
    }
  }, [])
  useEffect(() => {
    const live = screen.current
    if (!live) return
    const { terminal, palette } = live,
      previous = written.current
    const stdout = snapshotDelta(previous.stdout, props.stdout),
      stderr = snapshotDelta(previous.stderr, props.stderr)
    if (stdout.reset || stderr.reset || (previous.exit && (stdout.text || stderr.text))) {
      // A gap or replaced child result has no offset to resume. Replay the bounded snapshot once.
      terminal.reset()
      palette.reset()
      terminal.write(props.stdout + props.stderr)
      previous.exit = ''
    } else terminal.write(stdout.text + stderr.text)
    if (props.exitLine && previous.exit !== props.exitLine) {
      terminal.write(
        `\r\n\x1b[0m${props.exitTone === 'danger' ? '\x1b[31m' : '\x1b[2m'}${props.exitLine}\x1b[0m\r\n`,
      )
      previous.exit = props.exitLine
    }
    previous.stdout = props.stdout
    previous.stderr = props.stderr
  }, [props.stdout, props.stderr, props.exitLine, props.exitTone])
  useEffect(() => {
    const live = screen.current
    if (!live) return
    live.terminal.options.disableStdin = !props.writable
    live.terminal.textarea?.setAttribute('aria-label', props.label)
    live.fit()
    live.blink()
  }, [props.writable, props.label])
  return <div className="agh-terminal-screen" data-testid="workbench-terminal-output" ref={host} />
}
