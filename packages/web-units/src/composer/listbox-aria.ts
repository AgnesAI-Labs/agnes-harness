/** Suggestion lists share the textarea. A closing list only clears the attributes it owns. */
export function bindComposerListbox(input: HTMLTextAreaElement, listId: string, optionId?: string) {
  const attributes = {
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'true',
    'aria-controls': listId,
  }
  for (const [name, value] of Object.entries(attributes)) input.setAttribute(name, value)
  if (optionId) input.setAttribute('aria-activedescendant', optionId)
  else input.removeAttribute('aria-activedescendant')
  return () => {
    if (input.getAttribute('aria-controls') !== listId) return
    for (const name of Object.keys(attributes)) input.removeAttribute(name)
    input.removeAttribute('aria-activedescendant')
  }
}
