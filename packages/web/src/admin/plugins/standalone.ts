/** Legacy settings URL aliases the single workbench shell, retaining deep links. */
const target = new URL('/', location.href)
target.search = location.search
if (!target.searchParams.has('settings')) target.searchParams.set('settings', 'plugins')
location.replace(target.href)
