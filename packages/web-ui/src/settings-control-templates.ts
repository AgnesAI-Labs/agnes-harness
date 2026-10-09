/** Static shells use the same native control presentation as the React settings wrappers. */
export type SettingsControlTag = 'input' | 'select' | 'textarea'

export function createSettingsControl<K extends SettingsControlTag>(
  owner: Document,
  tag: K,
): HTMLElementTagNameMap[K] {
  const control = owner.createElement(tag)
  control.className = 'agnes-settings-input'
  return control
}

/** Controller-owned actions share the button skin without introducing a second event owner. */
export function createSettingsButton(owner: Document): HTMLButtonElement {
  const button = owner.createElement('button')
  button.type = 'button'
  button.className = 'agnes-ui-button'
  return button
}

/**
 * Materialize fixed host declarations before binding controllers. No root or state is retained:
 * the host owns the resulting native nodes, their values, events and removal as before.
 */
export function materializeSettingsControls(scope: ParentNode): void {
  for (const template of scope.querySelectorAll<HTMLTemplateElement>('template[data-agnes-control]')) {
    const tag = template.getAttribute('data-agnes-control')
    if (tag !== 'input' && tag !== 'select' && tag !== 'textarea')
      throw new Error(`unsupported settings control: ${tag}`)
    const control = createSettingsControl(template.ownerDocument, tag)
    for (const attribute of template.attributes) {
      if (attribute.name !== 'data-agnes-control') control.setAttribute(attribute.name, attribute.value)
    }
    control.classList.add('agnes-settings-input')
    if (tag !== 'input') control.append(template.content.cloneNode(true))
    const field = template.closest('label.form-field')
    if (field) {
      field.classList.add('agnes-ui-field')
      field.querySelector(':scope > span')?.classList.add('agnes-ui-field-label')
    }
    template.replaceWith(control)
  }
}
