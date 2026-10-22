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
