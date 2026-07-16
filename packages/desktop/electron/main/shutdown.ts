/** Coordinates one graceful runtime disposal before quitting or installing an update. */
export const createShutdown = ({
  dispose,
  quit,
}: {
  readonly dispose: () => Promise<void>
  readonly quit: () => void
}) => {
  let quitAllowed = false
  let quitRequested = false
  let disposal: Promise<void> | null = null
  const disposeOnce = () => {
    disposal ??= dispose()
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
