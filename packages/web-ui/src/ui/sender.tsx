import { Sender as XSender, type SenderProps as XSenderProps } from '@ant-design/x'
import { Input } from 'antd'
import {
  type ComponentProps,
  type ComponentRef,
  createContext,
  forwardRef,
  type TextareaHTMLAttributes,
  useContext,
  useMemo,
} from 'react'

type TextAreaProps = ComponentProps<typeof Input.TextArea>
export type SenderInputAttributes = Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & {
  [key: `aria-${string}`]: string | boolean | undefined
  [key: `data-${string}`]: string | boolean | undefined
}
export type SenderRef = ComponentRef<typeof XSender>
export type SenderProps = XSenderProps & {
  /** Attributes for the textarea itself; Sender's own rest props also land on its root element. */
  inputAttributes?: SenderInputAttributes
}

const InputAttributes = createContext<SenderInputAttributes>({})
// A stable component identity keeps the textarea mounted (caret, IME session) across renders.
const SenderInput = forwardRef<ComponentRef<typeof Input.TextArea>, TextAreaProps>(
  function SenderInput(props, ref) {
    return <Input.TextArea {...props} {...useContext(InputAttributes)} ref={ref} />
  },
)
const noAttributes: SenderInputAttributes = {}

/**
 * Ant Design X Sender with the Agnes base class and a way to address its textarea. The host
 * region is the card (skins paint it), so `agnes-ui-sender` draws no border, fill or shadow.
 * Return `false` from `onKeyDown` to keep the caller's keyboard contract the only one, and pass
 * `suffix={false}` when the caller supplies its own actions in `footer`.
 */
export const Sender = forwardRef<SenderRef, SenderProps>(function Sender(
  { inputAttributes = noAttributes, rootClassName, components, ...props },
  ref,
) {
  const merged = useMemo(() => ({ input: SenderInput, ...components }), [components])
  return (
    <InputAttributes.Provider value={inputAttributes}>
      <XSender
        {...props}
        ref={ref}
        components={merged}
        rootClassName={['agnes-ui-sender', rootClassName].filter(Boolean).join(' ')}
      />
    </InputAttributes.Provider>
  )
})
