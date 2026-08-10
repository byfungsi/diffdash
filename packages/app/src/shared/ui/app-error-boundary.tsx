import {
  decodeTransportError,
  hasBridgeTransportErrorEncoding,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"
import { Match, Predicate } from "effect"
import { Component, type ErrorInfo, type ReactNode } from "react"
import { rendererFailureInput } from "@/shared/errors"

interface AppErrorBoundaryProps {
  readonly children: ReactNode
  readonly onReload?: () => void
}

interface AppErrorBoundaryState {
  readonly errorMessage: string | null
}

/** Full-window fallback shown when DiffDash cannot safely continue rendering. */
export function AppErrorFallback({
  errorMessage,
  onReload,
}: {
  readonly errorMessage: string
  readonly onReload: () => void
}) {
  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center p-6">
      <section
        role="alert"
        aria-labelledby="app-error-title"
        className="bg-card w-full max-w-xl rounded-xl border p-6 shadow-sm"
      >
        <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          DiffDash beta
        </p>
        <h1 id="app-error-title" className="mt-2 text-xl font-semibold tracking-tight">
          DiffDash encountered an error
        </h1>
        <p className="text-muted-foreground mt-3 whitespace-pre-wrap break-words text-sm leading-6">
          {errorMessage}
        </p>
        <button
          type="button"
          className="bg-primary text-primary-foreground focus-visible:ring-ring mt-5 inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium shadow-xs transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:translate-y-px"
          onClick={onReload}
        >
          Reload DiffDash
        </button>
      </section>
    </main>
  )
}

/** Catches React failures plus otherwise-unhandled browser and IPC promise errors. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override readonly state: AppErrorBoundaryState = { errorMessage: null }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { errorMessage: errorMessage(error) }
  }

  override componentDidMount() {
    window.addEventListener("error", this.onWindowError)
    window.addEventListener("unhandledrejection", this.onUnhandledRejection)
  }

  override componentWillUnmount() {
    window.removeEventListener("error", this.onWindowError)
    window.removeEventListener("unhandledrejection", this.onUnhandledRejection)
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // oxlint-disable-next-line eslint/no-console -- Preserve fatal diagnostics for beta debugging.
    console.error("DiffDash render failure", errorMessage(error), info.componentStack)
  }

  private readonly onWindowError = (event: ErrorEvent) => {
    // oxlint-disable-next-line eslint/no-console -- Preserve fatal diagnostics for beta debugging.
    console.error("DiffDash runtime failure", errorMessage(event.error ?? event.message))
    this.setState({ errorMessage: errorMessage(event.error ?? event.message) })
  }

  private readonly onUnhandledRejection = (event: PromiseRejectionEvent) => {
    event.preventDefault()
    // oxlint-disable-next-line eslint/no-console -- Preserve fatal diagnostics for beta debugging.
    console.error("DiffDash unhandled promise rejection", errorMessage(event.reason))
    this.setState({ errorMessage: errorMessage(event.reason) })
  }

  override render() {
    if (this.state.errorMessage !== null) {
      return (
        <AppErrorFallback
          errorMessage={this.state.errorMessage}
          onReload={this.props.onReload ?? reloadWindow}
        />
      )
    }
    return this.props.children
  }
}

const errorMessage = <Value,>(error: Value): string => {
  const input = rendererFailureInput(error)
  const transport = decodeTransportError(input)
  if (transport !== null) return transport.message
  if (hasBridgeTransportErrorEncoding(input)) return UNKNOWN_TRANSPORT_ERROR_MESSAGE
  const unknownInput: unknown = error
  return Match.value(unknownInput).pipe(
    Match.when(Match.instanceOf(Error), (value) =>
      value.message.length > 0
        ? value.message
        : "An unknown error prevented DiffDash from continuing.",
    ),
    Match.when(Predicate.isString, (value) =>
      value.length > 0 ? value : "An unknown error prevented DiffDash from continuing.",
    ),
    Match.orElse(() => "An unknown error prevented DiffDash from continuing."),
  )
}

const reloadWindow = () => window.location.reload()
