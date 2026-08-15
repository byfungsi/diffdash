type ElectronBoundaryValue = Parameters<typeof JSON.stringify>[0]

type ShutdownState =
  | { readonly status: "running" }
  | { readonly status: "disposing"; readonly disposal: Promise<void> }
  | { readonly status: "quitAllowed" }

/** Coordinates one graceful runtime disposal before quitting or installing an update. */
export const createShutdown = ({
  dispose,
  quit,
  disposalTimeoutMs = 5_000,
  onDisposalError = defaultDisposalErrorReporter,
}: {
  readonly dispose: () => Promise<void>
  readonly quit: () => void
  readonly disposalTimeoutMs?: number
  readonly onDisposalError?: (cause: ElectronBoundaryValue) => void
}) => {
  let state: ShutdownState = { status: "running" }
  const disposeOnce = () => {
    if (state.status === "disposing") return state.disposal
    if (state.status === "quitAllowed") return Promise.resolve()

    const disposal = disposeWithin(dispose, disposalTimeoutMs).catch(
      (cause: ElectronBoundaryValue) => {
        try {
          onDisposalError(cause)
        } catch {
          defaultDisposalErrorReporter()
        }
      },
    )
    state = { status: "disposing", disposal }
    return disposal
  }

  return {
    beforeQuit: (event: { readonly preventDefault: () => void }) => {
      if (state.status === "quitAllowed") return
      event.preventDefault()
      if (state.status === "disposing") return
      void disposeOnce().then(() => {
        state = { status: "quitAllowed" }
        quit()
        return undefined
      })
    },
    restartAndInstall: async (install: () => Promise<void> | void) => {
      await disposeOnce()
      state = { status: "quitAllowed" }
      try {
        await install()
      } catch (cause) {
        quit()
        throw cause
      }
    },
  }
}

const disposeWithin = (dispose: () => Promise<void>, timeoutMs: number) => {
  const boundedTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 5_000
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Application runtime disposal exceeded ${boundedTimeout}ms`))
    }, boundedTimeout)
    void Promise.resolve()
      .then(dispose)
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout))
  })
}

const defaultDisposalErrorReporter = () => {
  console.error("[runtime:dispose-failed] Application cleanup did not complete cleanly")
}
