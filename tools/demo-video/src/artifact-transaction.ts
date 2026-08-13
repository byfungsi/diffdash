/* eslint-disable no-await-in-loop -- Promotion and rollback order is part of the transaction contract. */
import { access, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import { resolve } from "node:path"

import { assertDemoSlug, resolveContainedPath } from "./paths"

/** Owns one staged demo artifact write, contained promotion, obsolete cleanup, and rollback. */
export class DemoArtifactTransaction {
  readonly stagingDirectory: string
  readonly outputDirectory: string
  #committed = false

  private constructor(stagingDirectory: string, outputDirectory: string) {
    this.stagingDirectory = stagingDirectory
    this.outputDirectory = outputDirectory
  }

  /** Acquires and always removes a transaction staging directory. */
  static async run<A>(
    outputRoot: string,
    storyId: string,
    phase: string,
    operation: (transaction: DemoArtifactTransaction) => Promise<A>,
  ): Promise<A> {
    assertDemoSlug(storyId, "transaction story ID")
    assertDemoSlug(phase, "transaction phase")
    await mkdir(outputRoot, { recursive: true })
    const stagingDirectory = await mkdtemp(resolve(outputRoot, `.${storyId}-${phase}-`))
    const outputDirectory = resolveContainedPath(outputRoot, storyId)
    const outputExisted = await access(outputDirectory).then(
      () => true,
      () => false,
    )
    await mkdir(outputDirectory, { recursive: true })
    const transaction = new DemoArtifactTransaction(stagingDirectory, outputDirectory)
    try {
      return await operation(transaction)
    } catch (cause) {
      if (!outputExisted && !transaction.#committed) {
        await rm(outputDirectory, { recursive: true, force: true })
      }
      throw cause
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true })
    }
  }

  /** Resolves a path contained by this transaction's staging directory. */
  stagePath(file: string): string {
    return resolveContainedPath(this.stagingDirectory, file)
  }

  /** Resolves a path contained by this transaction's output directory. */
  outputPath(file: string): string {
    return resolveContainedPath(this.outputDirectory, file)
  }

  /** Atomically promotes staged files and removes matching obsolete output files. */
  async commit(
    files: readonly string[],
    { obsolete = () => false }: { readonly obsolete?: (file: string) => boolean } = {},
  ): Promise<void> {
    if (this.#committed) throw new Error("Demo artifact transaction is already committed")
    const uniqueFiles = new Set(files)
    if (uniqueFiles.size !== files.length) throw new Error("Demo transaction files must be unique")
    const existing = await readdir(this.outputDirectory)
    const obsoleteFiles = existing.filter((file) => !uniqueFiles.has(file) && obsolete(file))
    const destinations = [...files, ...obsoleteFiles]
    const backups: { readonly destination: string; readonly backup: string }[] = []
    const promoted: string[] = []
    try {
      for (const [index, file] of destinations.entries()) {
        const destination = this.outputPath(file)
        const exists = await access(destination).then(
          () => true,
          () => false,
        )
        if (!exists) continue
        const backup = this.stagePath(`.previous-${index}`)
        await rename(destination, backup)
        backups.push({ destination, backup })
      }
      for (const file of files) {
        const destination = this.outputPath(file)
        await rename(this.stagePath(file), destination)
        promoted.push(destination)
      }
    } catch (cause) {
      const rollbackErrors: unknown[] = []
      for (const path of promoted) {
        try {
          await rm(path, { force: true })
        } catch (error) {
          rollbackErrors.push(error)
        }
      }
      for (const { destination, backup } of backups.toReversed()) {
        try {
          await rename(backup, destination)
        } catch (error) {
          rollbackErrors.push(error)
        }
      }
      if (rollbackErrors.length > 0) {
        // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains the promotion cause and every rollback failure.
        throw new AggregateError(
          [cause, ...rollbackErrors],
          "Demo artifact promotion and rollback both failed.",
          { cause },
        )
      }
      throw cause
    }
    this.#committed = true
    await Promise.all(backups.map(({ backup }) => rm(backup, { force: true })))
  }
}
