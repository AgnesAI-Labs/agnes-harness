export type Snapshot = { text: string; cursor: number }

const MAX_STEPS = 100

/**
 * Undo history of a draft. A run of typed characters is one step; every other edit (a delete, a paste,
 * a completion) is a step of its own. Anything that moves the cursor ends the run.
 */
export class UndoStack {
  private past: Snapshot[] = []
  private future: Snapshot[] = []
  private typing = false
  /** Bumped by every change of the history that is not a recorded edit, so a caller can tell. */
  generation = 0

  /** Records the state before an edit; `typed` edits merge into the run already open. */
  record(before: Snapshot, typed: boolean): void {
    this.future = []
    if (typed && this.typing) return
    this.typing = typed
    this.past.push(before)
    if (this.past.length > MAX_STEPS) this.past.shift()
  }

  /** Ends the typing run, so the next typed character starts a new step. */
  endRun(): void {
    this.typing = false
  }

  undo(current: Snapshot): Snapshot | undefined {
    return this.step(this.past, this.future, current)
  }

  redo(current: Snapshot): Snapshot | undefined {
    return this.step(this.future, this.past, current)
  }

  clear(): void {
    this.past = []
    this.future = []
    this.typing = false
    this.generation++
  }

  private step(from: Snapshot[], to: Snapshot[], current: Snapshot): Snapshot | undefined {
    const target = from.pop()
    if (!target) return undefined
    to.push(current)
    this.typing = false
    this.generation++
    return target
  }
}
