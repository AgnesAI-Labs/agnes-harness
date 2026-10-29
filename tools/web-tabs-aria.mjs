import { readFile } from 'node:fs/promises'

// The overflow menu is an action beside the tabs, not a member of their tablist. Keep rc-tabs'
// markup, geometry and keyboard handlers; put the list role on the existing tab strip instead.
export const tabsAria = {
  name: 'agnes-tabs-aria',
  setup(build) {
    build.onLoad(
      { filter: /[/\\]@rc-component[/\\]tabs[/\\](?:es|lib)[/\\]TabNavList[/\\]index\.js$/ },
      async ({ path }) => {
        const source = await readFile(path, 'utf8')
        const role =
          '    role: "tablist",\n    "aria-orientation": tabPositionTopOrBottom ? \'horizontal\' : \'vertical\',\n'
        const strip = '    ref: tabListRef,\n'
        if (source.split(role).length !== 2 || source.split(strip).length !== 2)
          throw new Error('Tabs ARIA adapter needs review for this rc-tabs version')
        return { contents: source.replace(role, '').replace(strip, strip + role), loader: 'js' }
      },
    )
  },
}
