/** Two Esc presses within half a second, on an idle editor with nothing typed, ask for the rewind picker. */
export class DoubleEsc {
  private last: number | undefined

  press(armed: boolean, fire: () => void): void {
    const now = Date.now()
    const twice = armed && this.last !== undefined && now - this.last <= 500
    this.last = armed && !twice ? now : undefined
    if (twice) fire()
  }
}

/** Ctrl-C cancels the turn in flight; a second press within a second quits. */
export class DoubleCtrlC {
  private last: number | undefined

  press(cancel: () => Promise<void>, quit: () => void, fail: (error: unknown) => void): void {
    const now = Date.now()
    const quitting = this.last !== undefined && now - this.last <= 1_000
    this.last = quitting ? undefined : now
    void cancel()
      .catch(fail)
      .finally(() => {
        if (quitting) quit()
      })
  }
}
