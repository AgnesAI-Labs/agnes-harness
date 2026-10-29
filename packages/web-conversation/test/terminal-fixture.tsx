import { terminalKey } from '@agnes/web-ui'
import type { TerminalScreenProps } from '@agnes/web-ui/terminal'
import { vi } from 'vitest'

// Panel tests exercise the session contract. Emulator rendering and paste are tested in web-ui.
vi.mock('@agnes/web-ui/terminal', () => ({
  TerminalScreen: (props: TerminalScreenProps) => (
    <div data-testid="workbench-terminal-output">
      <output data-testid="terminal-fixture-raw">
        {props.stdout}
        {props.stderr}
        {props.exitLine}
      </output>
      <button type="button" data-testid="terminal-fixture-resize" onClick={() => props.onResize(80, 24)}>
        Fit
      </button>
      <input
        aria-label={props.label}
        disabled={!props.writable}
        onKeyDown={(event) => {
          const text = terminalKey(event)
          if (text !== undefined) props.onData(text)
        }}
        onPaste={(event) => props.onData(event.clipboardData.getData('text/plain').slice(0, 65536))}
      />
    </div>
  ),
}))
