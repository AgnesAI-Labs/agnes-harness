import { readFile } from 'node:fs/promises'

// rc-util's temporary scrollbar measurement stylesheet does not inherit ConfigProvider.csp.
// Keep the upstream measurement and cleanup, supplying the shell's existing authorized nonce.
export const scrollbarCsp = {
  name: 'agnes-scrollbar-csp',
  setup(build) {
    build.onLoad(
      { filter: /[/\\]@rc-component[/\\]util[/\\](?:es|lib)[/\\]getScrollBarSize\.js$/ },
      async ({ path }) => {
        const source = await readFile(path, 'utf8')
        const target = '`, randomId);'
        if (source.split(target).length !== 2)
          throw new Error('Scrollbar CSP adapter needs review for this rc-util version')
        return {
          contents: source.replace(
            target,
            '`, randomId, { csp: { nonce: document.querySelector(\'meta[name="agnes-csp-nonce"]\')?.content } });',
          ),
          loader: 'js',
        }
      },
    )
  },
}
