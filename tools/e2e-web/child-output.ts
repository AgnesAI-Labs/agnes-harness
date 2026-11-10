/** Keep the browser's own failure evidence visible through the heavy-tier test runner. */
export async function childOutput<T>(pending: Promise<T>): Promise<T> {
  try {
    return await pending
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const captured = error as Error & { stdout?: unknown; stderr?: unknown }
    const output = [captured.stdout, captured.stderr].filter(
      (value): value is string => typeof value === 'string' && !!value && !error.message.includes(value),
    )
    if (!output.length) throw error
    throw new Error([error.message, ...output].join('\n'), { cause: error })
  }
}
