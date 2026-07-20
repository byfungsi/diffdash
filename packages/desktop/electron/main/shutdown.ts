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
  readonly onDisposalError?: (cause: unknown) => void
}) => {
  let quitAllowed = false
  let quitRequested = false
  let disposal: Promise<void> | null = null
  const disposeOnce = () => {
    disposal ??= disposeWithin(dispose, disposalTimeoutMs).catch((cause: unknown) => {
      try {
        onDisposalError(cause)
      } catch {
        defaultDisposalErrorReporter()
      }
    })
    return disposal
  }

  return {
    beforeQuit: (event: { readonly preventDefault: () => void }) => {
      if (quitAllowed) return
      event.preventDefault()
      if (quitRequested) return
      quitRequested = true
      void disposeOnce().then(() => {
        quitAllowed = true
        quit()
        return undefined
      })
    },
    restartAndInstall: async (install: () => Promise<void> | void) => {
      await disposeOnce()
      quitAllowed = true
      await install()
    },
  }
}

const disposeWithin = (dispose: () => Promise<void>, timeoutMs: number) => {
  const boundedTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 5_000
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Application runtime disposal exceeded ${boundedTimeout}ms`)),
      boundedTimeout,
    )
  })
  return Promise.race([Promise.resolve().then(dispose), deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout)
  })
}

const defaultDisposalErrorReporter = () => {
  console.error("[runtime:dispose-failed] Application cleanup did not complete cleanly")
}
