import { createHash } from "node:crypto"
import { lstat, mkdir, realpath, rm } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

import { Effect, Schema } from "effect"

import { isNodeError, poolError } from "./hosted-review-workspace-pool-error"

const ManagedPoolRootSchema = Schema.String.pipe(Schema.brand("ManagedPoolRoot"))
const ManagedWorkspacePathSchema = Schema.String.pipe(Schema.brand("ManagedWorkspacePath"))

/** The canonical, app-owned root of one managed workspace pool. */
export type ManagedPoolRoot = typeof ManagedPoolRootSchema.Type

/** A lexically contained descendant constructed by a managed workspace filesystem. */
export type ManagedWorkspacePath = typeof ManagedWorkspacePathSchema.Type

interface FileIdentity {
  readonly device: number
  readonly inode: number
}

/**
 * Root-scoped filesystem operations that reject symlinks in managed path components.
 * Node has no portable descriptor-relative no-follow mutation API, so validation is adjacent to
 * destructive operations but cannot eliminate swaps by an unrelated filesystem actor.
 */
export interface ManagedWorkspaceFilesystem {
  readonly root: ManagedPoolRoot
  readonly path: (...segments: readonly string[]) => ManagedWorkspacePath
  readonly child: (path: ManagedWorkspacePath, name: string) => ManagedWorkspacePath
  readonly sibling: (path: ManagedWorkspacePath, name: string) => ManagedWorkspacePath
  readonly validate: (
    path: ManagedWorkspacePath,
    operation: string,
  ) => Effect.Effect<void, ReturnType<typeof poolError>>
  readonly exists: (
    path: ManagedWorkspacePath,
    operation: string,
  ) => Effect.Effect<boolean, ReturnType<typeof poolError>>
  readonly ensureDirectory: (
    path: ManagedWorkspacePath,
    operation: string,
  ) => Effect.Effect<void, ReturnType<typeof poolError>>
  readonly ensureParent: (
    path: ManagedWorkspacePath,
    operation: string,
  ) => Effect.Effect<void, ReturnType<typeof poolError>>
  readonly remove: (
    path: ManagedWorkspacePath,
    operation: string,
  ) => Effect.Effect<void, ReturnType<typeof poolError>>
}

/** Creates and canonicalizes a configured pool root, including a configured root symlink. */
export const makeManagedWorkspaceFilesystem = (
  configuredRoot: string,
): Effect.Effect<ManagedWorkspaceFilesystem, ReturnType<typeof poolError>> =>
  Effect.tryPromise({
    try: async () => {
      const requestedRoot = resolve(configuredRoot)
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
      const canonicalRoot = await realpath(requestedRoot)
      const rootDetails = await lstat(canonicalRoot)
      if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
        throw new Error(`Managed workspace root is not a directory: ${canonicalRoot}`)
      }

      const root = ManagedPoolRootSchema.make(canonicalRoot)
      const rootIdentity = identityOf(rootDetails)

      const managedPath = (...segments: readonly string[]) => {
        for (const segment of segments) validateManagedPathSegment(segment)
        const candidate = resolve(root, ...segments)
        assertContained(root, candidate)
        return ManagedWorkspacePathSchema.make(candidate)
      }

      const sibling = (path: ManagedWorkspacePath, name: string) => {
        validateManagedPathSegment(name)
        const candidate = resolve(dirname(path), name)
        assertContained(root, candidate)
        return ManagedWorkspacePathSchema.make(candidate)
      }

      const child = (path: ManagedWorkspacePath, name: string) => {
        validateManagedPathSegment(name)
        const candidate = resolve(path, name)
        assertContained(root, candidate)
        return ManagedWorkspacePathSchema.make(candidate)
      }

      const inspect = async (path: ManagedWorkspacePath): Promise<boolean> => {
        assertContained(root, path)
        const currentRoot = await lstat(root)
        if (
          currentRoot.isSymbolicLink() ||
          !currentRoot.isDirectory() ||
          !sameIdentity(rootIdentity, identityOf(currentRoot))
        ) {
          throw new Error(`Managed workspace root identity changed: ${root}`)
        }

        const segments = descendantSegments(root, path)
        let current = String(root)
        for (const [index, segment] of segments.entries()) {
          current = resolve(current, segment)
          let nodeDetails
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Components must be inspected before their descendants.
            nodeDetails = await lstat(current)
          } catch (cause) {
            if (isNodeError(cause, "ENOENT")) return false
            throw cause
          }
          if (nodeDetails.isSymbolicLink()) {
            throw new Error(`Managed workspace path contains a symbolic link: ${current}`)
          }
          if (index < segments.length - 1 && !nodeDetails.isDirectory()) {
            throw new Error(`Managed workspace path ancestor is not a directory: ${current}`)
          }
        }
        return true
      }

      const ensureDirectory = async (path: ManagedWorkspacePath) => {
        assertContained(root, path)
        const currentRoot = await lstat(root)
        if (
          currentRoot.isSymbolicLink() ||
          !currentRoot.isDirectory() ||
          !sameIdentity(rootIdentity, identityOf(currentRoot))
        ) {
          throw new Error(`Managed workspace root identity changed: ${root}`)
        }

        let current = String(root)
        for (const segment of descendantSegments(root, path)) {
          current = resolve(current, segment)
          let nodeDetails
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Components must be created and verified in order.
            nodeDetails = await lstat(current)
          } catch (cause) {
            if (!isNodeError(cause, "ENOENT")) throw cause
            try {
              // oxlint-disable-next-line eslint/no-await-in-loop -- A parent must exist before creating its child.
              await mkdir(current, { mode: 0o700 })
            } catch (mkdirCause) {
              if (!isNodeError(mkdirCause, "EEXIST")) throw mkdirCause
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- Verify the component created in this iteration.
            nodeDetails = await lstat(current)
          }
          if (nodeDetails.isSymbolicLink()) {
            throw new Error(`Managed workspace path contains a symbolic link: ${current}`)
          }
          if (!nodeDetails.isDirectory()) {
            throw new Error(`Managed workspace directory path is not a directory: ${current}`)
          }
        }
      }

      return {
        root,
        path: managedPath,
        child,
        sibling,
        validate: (path, operation) =>
          wrapFilesystemOperation(operation, () => inspect(path)).pipe(Effect.asVoid),
        exists: (path, operation) => wrapFilesystemOperation(operation, () => inspect(path)),
        ensureDirectory: (path, operation) =>
          wrapFilesystemOperation(operation, () => ensureDirectory(path)),
        ensureParent: (path, operation) =>
          wrapFilesystemOperation(operation, async () => {
            const parent = dirname(path)
            if (parent === root) {
              await inspect(path)
              return
            }
            await ensureDirectory(ManagedWorkspacePathSchema.make(parent))
          }),
        remove: (path, operation) =>
          wrapFilesystemOperation(operation, async () => {
            if (!(await inspect(path))) return
            await rm(path, { recursive: true, force: true })
          }),
      }
    },
    catch: (cause) =>
      poolError(
        "filesystem",
        "filesystem.root",
        "DiffDash could not create and canonicalize its managed workspace root.",
        cause,
      ),
  })

/** Derives a generated repository directory inside the canonical managed root. */
export const pathForRepository = (
  filesystem: ManagedWorkspaceFilesystem,
  repositoryKey: string,
) => {
  const digest = createHash("sha256").update(repositoryKey).digest("hex")
  return filesystem.path("repositories", digest)
}

/** Derives a generated slot directory without accepting arbitrary relative filesystem paths. */
export const pathForSlot = (
  filesystem: ManagedWorkspaceFilesystem,
  slot: { readonly repositoryKey: string; readonly id: string },
) => filesystem.path("repositories", repositoryDigest(slot.repositoryKey), safeSegment(slot.id))

/** Validates one manifest-derived path component before it can influence a filesystem path. */
export const validateManagedPathSegment = (value: string): void => {
  safeSegment(value)
}

const repositoryDigest = (repositoryKey: string) =>
  createHash("sha256").update(repositoryKey).digest("hex")

const safeSegment = (value: string) => {
  if (!/^[a-zA-Z0-9_.-]+$/u.test(value) || value === "." || value === "..") {
    throw poolError(
      "filesystem",
      "path.segment",
      "A managed workspace path contains an unsafe component.",
      new Error(`Unsafe path segment: ${value}`),
    )
  }
  return value.toLowerCase()
}

const assertContained = (root: ManagedPoolRoot, path: string) => {
  const child = relative(root, resolve(path))
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw poolError(
      "filesystem",
      "path.containment",
      "A managed workspace path escaped the configured pool root.",
      new Error(path),
    )
  }
}

const descendantSegments = (root: ManagedPoolRoot, path: ManagedWorkspacePath) => {
  assertContained(root, path)
  return relative(root, path).split(sep)
}

const identityOf = (details: { readonly dev: number; readonly ino: number }): FileIdentity => ({
  device: details.dev,
  inode: details.ino,
})

const sameIdentity = (left: FileIdentity, right: FileIdentity) =>
  left.device === right.device && left.inode === right.inode

const wrapFilesystemOperation = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      poolError(
        "filesystem",
        operation,
        "DiffDash rejected or could not access a managed workspace path.",
        cause,
      ),
  })
