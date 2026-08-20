import {
  CodeWorkspaceDirectoryPage,
  CodeWorkspaceEntry,
  CodeWorkspaceError,
} from "@diffdash/domain/code-workspace"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Context, Effect, Layer, Schema } from "effect"
import { lstat, readdir, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

/** Filesystem access for lazily browsing an isolated managed checkout. */
export class ManagedWorkspaceFiles extends Context.Service<
  ManagedWorkspaceFiles,
  {
    readonly listDirectory: (
      rootPath: RepositoryCheckoutPath,
      path: RepositoryRelativePath | null,
      offset: number,
      limit: number,
    ) => Effect.Effect<CodeWorkspaceDirectoryPage, CodeWorkspaceError>
    readonly indexFiles: (
      rootPath: RepositoryCheckoutPath,
    ) => Effect.Effect<readonly RepositoryRelativePath[], CodeWorkspaceError>
  }
>()("@diffdash/local-git/ManagedWorkspaceFiles") {
  /** Production filesystem implementation constrained to a canonical managed checkout root. */
  static readonly layer = Layer.succeed(
    ManagedWorkspaceFiles,
    ManagedWorkspaceFiles.of({
      listDirectory: Effect.fn("ManagedWorkspaceFiles.listDirectory")(
        function* (rootPath, path, offset, limit) {
          const root = yield* canonicalRoot(rootPath, "listDirectory")
          const directory = yield* containedDirectory(root, path, "listDirectory")
          const entries = yield* readDirectory(directory, "listDirectory")
          const parsed: CodeWorkspaceEntry[] = []
          for (const entry of entries) {
            if (path === null && entry.name === ".git") continue
            const child = yield* parseRelativePath(
              path === null ? entry.name : `${path}/${entry.name}`,
              "listDirectory",
            )
            parsed.push(
              CodeWorkspaceEntry.make({
                path: child,
                kind: entry.isDirectory() && !entry.isSymbolicLink() ? "directory" : "file",
              }),
            )
          }
          parsed.sort(
            (left, right) =>
              Number(left.kind === "file") - Number(right.kind === "file") ||
              left.path.localeCompare(right.path),
          )
          const end = Math.min(offset + limit, parsed.length)
          return CodeWorkspaceDirectoryPage.make({
            entries: parsed.slice(offset, end),
            nextOffset: end < parsed.length ? end : null,
          })
        },
      ),
      indexFiles: Effect.fn("ManagedWorkspaceFiles.indexFiles")(function* (rootPath) {
        const root = yield* canonicalRoot(rootPath, "indexFiles")
        const pending: Array<{ readonly directory: string; readonly path: string | null }> = [
          { directory: root, path: null },
        ]
        const files: RepositoryRelativePath[] = []
        while (pending.length > 0) {
          const current = pending.pop()
          if (current === undefined) break
          const entries = yield* readDirectory(current.directory, "indexFiles")
          for (const entry of entries) {
            if (current.path === null && entry.name === ".git") continue
            const rawPath = current.path === null ? entry.name : `${current.path}/${entry.name}`
            const path = yield* parseRelativePath(rawPath, "indexFiles")
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
              pending.push({ directory: resolve(root, ...path.split("/")), path })
            } else {
              files.push(path)
            }
          }
        }
        files.sort((left, right) => left.localeCompare(right))
        return files
      }),
    }),
  )
}

const canonicalRoot = (rootPath: RepositoryCheckoutPath, operation: string) =>
  Effect.tryPromise({
    try: async () => {
      const root = await realpath(rootPath)
      if (!(await lstat(root)).isDirectory()) throw new Error("Workspace root is not a directory")
      return root
    },
    catch: () =>
      workspaceError(operation, "workspaceUnavailable", "The Code workspace is unavailable."),
  })

const containedDirectory = (root: string, path: RepositoryRelativePath | null, operation: string) =>
  Effect.tryPromise({
    try: async () => {
      const candidate = path === null ? root : resolve(root, ...path.split("/"))
      const canonical = await realpath(candidate)
      if (!isContained(root, canonical)) throw new Error("Directory escaped workspace root")
      const details = await lstat(canonical)
      if (!details.isDirectory()) throw new Error("Workspace path is not a directory")
      return canonical
    },
    catch: () =>
      workspaceError(operation, "invalidPath", "The requested Code directory is unavailable."),
  })

const readDirectory = (path: string, operation: string) =>
  Effect.tryPromise({
    try: () => readdir(path, { withFileTypes: true }),
    catch: () =>
      workspaceError(
        operation,
        "workspaceUnavailable",
        "DiffDash could not read the Code workspace.",
      ),
  })

const parseRelativePath = (path: string, operation: string) =>
  Schema.decodeUnknownEffect(RepositoryRelativePath)(path).pipe(
    Effect.mapError(() =>
      workspaceError(operation, "invalidPath", "The Code workspace contains an invalid path."),
    ),
  )

const isContained = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate)
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
}

const workspaceError = (operation: string, reason: CodeWorkspaceError["reason"], message: string) =>
  CodeWorkspaceError.make({ operation, reason, message })
