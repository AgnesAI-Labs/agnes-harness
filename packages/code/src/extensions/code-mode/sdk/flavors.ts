export type RunCodeFlavor = Readonly<{ language: string; description: string }>

/** Descriptions are not capability declarations. A runtime and renderer must also exist before
 * the host may offer a language; TypeScript remains a planned backend. */
export const RUN_CODE_FLAVORS: Readonly<Record<'python' | 'typescript', RunCodeFlavor>> = Object.freeze({
  python: Object.freeze({
    language: 'python',
    description:
      'Run a Python cell in the persistent kernel. Call harness tools via `await tools.<name>(...)`. ' +
      'Assign large results to variables and print summaries. `%%bash` on the first line runs a throw-away shell.',
  }),
  typescript: Object.freeze({
    language: 'typescript',
    description:
      'Run a TypeScript program in the code runtime. Call harness tools via `await tools.<name>(...)`. ' +
      'Assign large results to variables and log summaries.',
  }),
})

export function runCodeDescription(language: string): string {
  if (!Object.hasOwn(RUN_CODE_FLAVORS, language)) throw new Error('no run_code flavor for requested language')
  return RUN_CODE_FLAVORS[language as keyof typeof RUN_CODE_FLAVORS].description
}
