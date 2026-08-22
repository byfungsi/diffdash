import { OpenCodeConnectionSelection, OpenCodeSessionSummary } from "@diffdash/domain/comment"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  ConnectOpenCodeSessionRequest,
  ListOpenCodeSessionsRequest,
} from "@diffdash/protocol/ai-connection"
import { Option, Schema } from "effect"
import { Bot, Check, ChevronRight, Loader2, Search } from "lucide-react"
import { DropdownMenu } from "radix-ui"
import { useEffect, useEffectEvent, useRef, useState } from "react"

import { runRendererPromise, useDesktopRuntime } from "@/platform/renderer-runtime"
import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"

const SessionLoadState = Schema.TaggedUnion({
  Idle: {},
  Loading: {},
  Loaded: { sessions: Schema.Array(OpenCodeSessionSummary) },
  Failed: { message: Schema.String },
})

/** Titlebar menu for choosing DiffDash or an OpenCode session as comment owner. */
export const AIConnectionMenu = ({
  directory,
  projectId,
  selected,
  onChange,
}: {
  readonly directory: Option.Option<RepositoryCheckoutPath>
  readonly projectId: Option.Option<ReviewProjectId>
  readonly selected: Option.Option<OpenCodeConnectionSelection>
  readonly onChange: (selection: Option.Option<OpenCodeConnectionSelection>) => void
}) => {
  const desktop = useDesktopRuntime()
  const [open, setOpen] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [loadState, setLoadState] = useState<typeof SessionLoadState.Type>(
    SessionLoadState.cases.Idle.make({}),
  )
  const [connectingId, setConnectingId] = useState<Option.Option<string>>(Option.none())
  const searchGeneration = useRef(0)
  const connectionGeneration = useRef(0)
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId

  const loadSessions = useEffectEvent(async (search: string) => {
    const activeProjectId = projectIdRef.current
    if (Option.isNone(activeProjectId)) return
    const generation = ++searchGeneration.current
    setLoadState(SessionLoadState.cases.Loading.make({}))
    try {
      const trimmed = search.trim()
      const sessions = await runRendererPromise(
        desktop.ai.listOpenCodeSessions(
          ListOpenCodeSessionsRequest.make({
            projectId: activeProjectId.value,
            search: trimmed.length > 0 ? trimmed : null,
          }),
        ),
      )
      if (
        generation === searchGeneration.current &&
        Option.contains(projectIdRef.current, activeProjectId.value)
      ) {
        setLoadState(SessionLoadState.cases.Loaded.make({ sessions: [...sessions] }))
      }
    } catch (cause) {
      if (generation === searchGeneration.current) {
        setLoadState(
          SessionLoadState.cases.Failed.make({
            message: formatError(cause, "Could not load OpenCode sessions"),
          }),
        )
      }
    }
  })

  useEffect(() => {
    searchGeneration.current += 1
    connectionGeneration.current += 1
    setConnectingId(Option.none())
    if (!open) {
      setProviderOpen(false)
      setQuery("")
      setLoadState(SessionLoadState.cases.Idle.make({}))
      return () => undefined
    }
    if (!providerOpen || Option.isNone(directory)) return () => undefined
    const delay = Option.match(
      Option.liftPredicate(query, (value) => value.length > 0),
      {
        onNone: () => 0,
        onSome: () => 250,
      },
    )
    const timer = window.setTimeout(() => void loadSessions(query), delay)
    return () => {
      window.clearTimeout(timer)
    }
  }, [directory, open, providerOpen, query])

  const connect = async (session: OpenCodeSessionSummary) => {
    const activeProjectId = projectIdRef.current
    if (Option.isNone(activeProjectId) || Option.isSome(connectingId)) {
      return
    }
    const generation = ++connectionGeneration.current
    setConnectingId(Option.some(session.id))
    try {
      const connection = await runRendererPromise(
        desktop.ai.connectOpenCodeSession(
          ConnectOpenCodeSessionRequest.make({
            sessionId: session.id,
            projectId: activeProjectId.value,
          }),
        ),
      )
      if (
        generation !== connectionGeneration.current ||
        !Option.contains(projectIdRef.current, activeProjectId.value)
      ) {
        return
      }
      onChange(
        Option.some(
          OpenCodeConnectionSelection.make({
            projectId: activeProjectId.value,
            session,
            planMode: connection.planMode,
          }),
        ),
      )
      setOpen(false)
    } catch (cause) {
      if (generation === connectionGeneration.current) {
        setLoadState(
          SessionLoadState.cases.Failed.make({
            message: formatError(cause, "Could not connect to this OpenCode session"),
          }),
        )
      }
    } finally {
      if (generation === connectionGeneration.current) setConnectingId(Option.none())
    }
  }

  const label = Option.match(selected, {
    onNone: () => "Connect AI",
    onSome: ({ session }) => `OpenCode · ${session.title}`,
  })

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={Option.isNone(projectId)}
          data-workbench-ai-connection
          className="text-shell-titlebar-muted hover:bg-shell-titlebar-control-hover hover:text-shell-titlebar-fg max-w-60"
          title={label}
        >
          <Bot className="size-4" />
          <span className="hidden max-w-44 truncate lg:inline">{label}</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="bg-popover text-popover-foreground z-50 min-w-64 rounded-xl border p-1 shadow-xl"
        >
          <DropdownMenu.Item
            className="data-[highlighted]:bg-accent flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-xs outline-none"
            onSelect={() => {
              connectionGeneration.current += 1
              setConnectingId(Option.none())
              onChange(Option.none())
            }}
          >
            <span className="flex size-4 items-center justify-center">
              {Option.match(selected, {
                onNone: () => <Check className="size-3.5" />,
                onSome: () => null,
              })}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">No connection</span>
              <span className="text-muted-foreground block">Review in DiffDash</span>
            </span>
          </DropdownMenu.Item>
          <DropdownMenu.Sub open={providerOpen} onOpenChange={setProviderOpen}>
            <DropdownMenu.SubTrigger className="data-[highlighted]:bg-accent flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-xs outline-none">
              <Bot className="size-4" />
              <span className="min-w-0 flex-1 font-medium">OpenCode</span>
              <ChevronRight className="size-3.5" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={4}
                alignOffset={-4}
                className="bg-popover text-popover-foreground z-50 w-80 rounded-xl border p-1 shadow-xl"
              >
                {Option.match(directory, {
                  onNone: () => (
                    <div className="text-muted-foreground px-3 py-4 text-xs">
                      Link a local checkout to browse OpenCode sessions.
                    </div>
                  ),
                  onSome: () => (
                    <>
                      <div className="flex items-center gap-2 border-b px-2 py-1.5">
                        <Search className="text-muted-foreground size-3.5" />
                        <Input
                          aria-label="Search OpenCode sessions"
                          value={query}
                          placeholder="Search sessions"
                          className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                          onKeyDown={(event) => {
                            if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
                              event.stopPropagation()
                            }
                          }}
                          onChange={(event) => setQuery(event.currentTarget.value)}
                        />
                      </div>
                      <div className="max-h-72 overflow-y-auto py-1">
                        {SessionLoadState.match(loadState, {
                          Idle: () => null,
                          Loading: () => (
                            <div className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-xs">
                              <Loader2 className="size-3.5 animate-spin" /> Loading sessions
                            </div>
                          ),
                          Failed: ({ message }) => (
                            <div role="alert" className="text-destructive px-3 py-3 text-xs">
                              {message}
                            </div>
                          ),
                          Loaded: ({ sessions }) => {
                            if (sessions.length === 0) {
                              const message = Option.match(
                                Option.liftPredicate(query.trim(), (value) => value.length > 0),
                                {
                                  onNone: () => "No OpenCode sessions found for this project.",
                                  onSome: () => "No matching OpenCode sessions.",
                                },
                              )
                              return (
                                <div className="text-muted-foreground px-3 py-4 text-xs">
                                  {message}
                                </div>
                              )
                            }
                            return sessions.map((session) => (
                              <DropdownMenu.Item
                                key={session.id}
                                disabled={Option.isSome(connectingId)}
                                className="data-[highlighted]:bg-accent flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-xs outline-none disabled:opacity-50"
                                onSelect={(event) => {
                                  event.preventDefault()
                                  void connect(session)
                                }}
                              >
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium">
                                    {session.title}
                                  </span>
                                  <span className="text-muted-foreground block truncate font-mono text-caption">
                                    {session.directory}
                                  </span>
                                </span>
                                {Option.match(connectingId, {
                                  onNone: () =>
                                    Option.match(selected, {
                                      onNone: () => null,
                                      onSome: (connection) => {
                                        if (connection.session.id !== session.id) return null
                                        return <Check className="size-3.5" />
                                      },
                                    }),
                                  onSome: (id) => {
                                    if (id !== session.id) return null
                                    return <Loader2 className="size-3.5 animate-spin" />
                                  },
                                })}
                              </DropdownMenu.Item>
                            ))
                          },
                        })}
                      </div>
                    </>
                  ),
                })}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
