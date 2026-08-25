import { createContext, type ReactNode, use } from "react"

interface CodeActivityPaneContent {
  readonly contextPane: ReactNode
  readonly mainPane: ReactNode
}

const CodeActivityPaneContext = createContext<CodeActivityPaneContent | null>(null)

/** Supplies the Code extension's tree and viewer projections to its registered activity slots. */
export const CodeActivityPaneProvider = ({
  children,
  contextPane,
  mainPane,
}: CodeActivityPaneContent & { readonly children: ReactNode }) => (
  <CodeActivityPaneContext value={{ contextPane, mainPane }}>{children}</CodeActivityPaneContext>
)

const useCodeActivityPaneContent = (): CodeActivityPaneContent => {
  const content = use(CodeActivityPaneContext)
  if (content === null) throw new Error("Code activity pane provider is unavailable")
  return content
}

/** Renders the repository tree contributed by the trusted Code extension. */
export const CodeActivityContextPane = () => useCodeActivityPaneContent().contextPane

/** Renders the source viewer contributed by the trusted Code extension. */
export const CodeActivityMainPane = (_props: { readonly baseMain: ReactNode }) =>
  useCodeActivityPaneContent().mainPane
