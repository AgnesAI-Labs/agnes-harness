/**
 * Opt-in startup phase marks. With `AGH_TIMING=1` each phase writes one `agh-timing <phase> <ms>`
 * line to stderr, never stdout; without it every call is a single environment check and prints
 * nothing. Milliseconds count from `AGH_TIMING_ORIGIN` (the launcher's `performance.timeOrigin`,
 * passed down so a child process shares the launcher's timeline) or from this process's own origin.
 */
export function timingMark(
  phase: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  write: (line: string) => void = (line) => {
    process.stderr.write(line)
  },
): void {
  if (env.AGH_TIMING !== '1') return
  const given = Number(env.AGH_TIMING_ORIGIN)
  const origin = Number.isFinite(given) && given > 0 ? given : performance.timeOrigin
  write(`agh-timing ${phase} ${(performance.timeOrigin + performance.now() - origin).toFixed(1)}\n`)
}
