import {
  App,
  trustedWebReviewExtensions,
  getSystemColorScheme,
  resolveThemePreference,
  THEME_DEFINITIONS,
} from "@diffdash/app"
import { GitPullRequest, KeyRound, ShieldCheck } from "lucide-react"
import { useEffect, useLayoutEffect, useState } from "react"
import { Schema } from "effect"

import { createCloudApi, createCloudBridge } from "./cloud-api"
import { CloudStorage } from "./cloud-storage"
import { captureCloudEvent } from "./cloud-analytics"
import { cloudSessionExtension } from "./cloud-session-extension"
import { createCloudNavigation, type CloudNavigationStatus } from "./cloud-navigation"
import { GithubClient, GithubRequestError } from "./github-client"
import {
  clearGithubPersonalAccessToken,
  loadGithubPersonalAccessToken,
  parseGithubPersonalAccessToken,
  saveGithubPersonalAccessToken,
  type GithubPersonalAccessToken,
} from "./github-credentials"

type AuthenticatedGithub = {
  readonly client: GithubClient
  readonly login: string
}

const storage = new CloudStorage()
const cloudExtensions = [...trustedWebReviewExtensions, cloudSessionExtension]

/** Browser authentication gate that retains the requested URL until GitHub identity is verified. */
export function CloudRoot({ request = fetch }: { readonly request?: typeof fetch }) {
  const [authentication, setAuthentication] = useState<AuthenticatedGithub | null>(null)
  const [checkingStoredToken, setCheckingStoredToken] = useState(true)

  useLayoutEffect(() => {
    if (authentication !== null) return undefined
    const settings = storage.loadSettings()
    const applyTheme = () => {
      const theme = resolveThemePreference(
        settings.appearance,
        settings.themes,
        getSystemColorScheme(),
      )
      const { colorScheme } = THEME_DEFINITIONS[theme]
      document.documentElement.dataset.theme = theme
      document.documentElement.classList.toggle("dark", colorScheme === "dark")
      document.documentElement.style.colorScheme = colorScheme
    }
    applyTheme()
    if (settings.appearance !== "system") return undefined
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", applyTheme)
    return () => media.removeEventListener("change", applyTheme)
  }, [authentication])

  useEffect(() => {
    const storedToken = loadGithubPersonalAccessToken()
    if (storedToken === null) {
      setCheckingStoredToken(false)
      return
    }
    void authenticate(storedToken, request).then(
      (authenticated) => {
        setAuthentication(authenticated)
        setCheckingStoredToken(false)
        return undefined
      },
      () => {
        clearGithubPersonalAccessToken()
        setCheckingStoredToken(false)
        return undefined
      },
    )
  }, [request])

  if (checkingStoredToken) return <CredentialCheck />
  if (authentication === null) {
    return (
      <CredentialGate
        request={request}
        onAuthenticated={(authenticated, token) => {
          saveGithubPersonalAccessToken(token)
          setAuthentication(authenticated)
        }}
      />
    )
  }

  return <AuthenticatedCloud authentication={authentication} />
}

function AuthenticatedCloud({ authentication }: { readonly authentication: AuthenticatedGithub }) {
  const [navigationStatus, setNavigationStatus] = useState<CloudNavigationStatus>({
    kind: "loading",
  })
  const [runtime] = useState(() => ({
    bridge: createCloudBridge(createCloudApi(authentication.client, storage)),
    navigation: createCloudNavigation(
      authentication.client,
      storage,
      {
        pathname: () => window.location.pathname,
        push: (pathname) => window.history.pushState(null, "", pathname),
        subscribe: (listener) => {
          window.addEventListener("popstate", listener)
          return () => window.removeEventListener("popstate", listener)
        },
      },
      setNavigationStatus,
    ),
  }))
  Object.defineProperty(window, "diffDash", {
    configurable: true,
    value: runtime.bridge,
  })
  return (
    <div className="relative h-dvh min-h-0 overflow-hidden">
      <App
        capabilities={{ localProjects: false, reviewViewport: "code-view" }}
        extensions={cloudExtensions}
        navigation={runtime.navigation}
      />
      {navigationStatus.kind === "ready" ? null : (
        <section className="bg-background text-foreground absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 p-6">
          {navigationStatus.kind === "loading" ? (
            <output>Opening review...</output>
          ) : (
            <>
              <p role="alert">{navigationStatus.message}</p>
              <a className="text-primary underline underline-offset-4" href="/">
                Return to repositories
              </a>
            </>
          )}
        </section>
      )}
    </div>
  )
}

function CredentialCheck() {
  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center p-6">
      <output className="text-muted-foreground flex items-center gap-3 text-sm">
        <span className="bg-primary size-2 animate-pulse rounded-full" />
        Checking the GitHub connection stored in this browser
      </output>
    </main>
  )
}

function CredentialGate({
  onAuthenticated,
  request,
}: {
  readonly request: typeof fetch
  readonly onAuthenticated: (
    authentication: AuthenticatedGithub,
    token: GithubPersonalAccessToken,
  ) => void
}) {
  const [personalAccessToken, setPersonalAccessToken] = useState("")
  const [status, setStatus] = useState<"idle" | "checking">("idle")
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    setError(null)
    let token: GithubPersonalAccessToken
    try {
      token = parseGithubPersonalAccessToken(personalAccessToken)
    } catch {
      setError("Enter a valid GitHub personal access token.")
      return
    }
    setStatus("checking")
    try {
      onAuthenticated(await authenticate(token, request), token)
      void captureCloudEvent({ event: "github_connected" })
    } catch (cause) {
      void captureCloudEvent({ event: "github_connection_failed" })
      setError(
        Schema.is(GithubRequestError)(cause)
          ? cause.safeMessage
          : "DiffDash could not verify this GitHub token.",
      )
      setStatus("idle")
    }
  }

  return (
    <main className="cloud-auth-grid bg-background text-foreground relative flex min-h-dvh items-center overflow-hidden px-4 py-10 sm:px-8">
      <div className="bg-background/85 absolute inset-0 backdrop-blur-[1px]" aria-hidden="true" />
      <section className="border-border bg-card relative mx-auto grid w-full max-w-5xl overflow-hidden rounded-xl border shadow-2xl lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-h-72 flex-col justify-between border-b p-6 sm:p-10 lg:min-h-[34rem] lg:border-r lg:border-b-0">
          <div className="flex items-center gap-3 text-sm font-semibold">
            <span className="bg-primary text-primary-foreground grid size-9 place-items-center rounded-md">
              <GitPullRequest className="size-5" />
            </span>
            DiffDash Cloud
          </div>
          <div className="max-w-xl py-12 lg:py-0">
            <p className="text-primary mb-3 font-mono text-xs font-semibold tracking-widest uppercase">
              Browser-local preview
            </p>
            <h1 className="text-4xl leading-[1.04] font-semibold tracking-tight sm:text-5xl">
              Review GitHub changes without leaving the thread.
            </h1>
            <p className="text-muted-foreground mt-5 max-w-lg text-sm leading-6 sm:text-base">
              Your token and review state stay in this browser. GitHub remains the source of truth.
            </p>
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <ShieldCheck className="text-primary size-4" />
            Read-only provider capabilities in v0
          </div>
        </div>

        <form
          className="flex flex-col justify-center p-6 sm:p-8"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <KeyRound className="text-primary mb-7 size-6" />
          <h2 className="text-xl font-semibold tracking-tight">Connect GitHub</h2>
          <p className="text-muted-foreground mt-2 text-sm leading-5">
            Use a fine-grained PAT limited to the repositories you want to review.
          </p>
          <label className="mt-7 grid gap-2 text-xs font-medium" htmlFor="github-token">
            Personal access token
            <input
              id="github-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={personalAccessToken}
              className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring h-10 rounded-md border px-3 font-mono text-sm outline-none focus-visible:ring-2"
              placeholder="github_pat_..."
              aria-describedby="github-token-help github-token-error"
              onChange={(event) => setPersonalAccessToken(event.target.value)}
            />
          </label>
          <p id="github-token-help" className="text-muted-foreground mt-2 text-xs leading-5">
            Stored in localStorage on this device. Any script running on this origin could read it.
          </p>
          <p id="github-token-error" className="text-destructive mt-3 min-h-5 text-xs" role="alert">
            {error}
          </p>
          <button
            type="submit"
            disabled={status === "checking" || personalAccessToken.trim().length === 0}
            className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring mt-3 h-10 rounded-md px-4 text-sm font-semibold outline-none transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2"
          >
            {status === "checking" ? "Checking token..." : "Open DiffDash"}
          </button>
          <a
            className="text-muted-foreground hover:text-foreground mt-4 text-center text-xs underline underline-offset-4"
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noreferrer"
          >
            Create a fine-grained token
          </a>
        </form>
      </section>
    </main>
  )
}

const authenticate = async (
  token: GithubPersonalAccessToken,
  request: typeof fetch,
): Promise<AuthenticatedGithub> => {
  const client = new GithubClient(token, request)
  const viewer = await client.getViewer()
  return { client, login: viewer.login }
}
