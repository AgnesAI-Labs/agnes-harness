import { createContext, type ReactNode, useContext } from 'react'
import { XProvider } from '../x/index.js'

const InsideXScope = createContext(false)

/**
 * Ant Design X components need one provider ancestor. The stream opens it once; a leaf mounted on
 * its own (a bridged tool card or action footer) opens its own, and nested leaves reuse the outer one.
 */
export function ConversationXScope({ children }: { children: ReactNode }) {
  if (useContext(InsideXScope)) return children
  return (
    <InsideXScope.Provider value={true}>
      <XProvider>{children}</XProvider>
    </InsideXScope.Provider>
  )
}
