import { describe, expect, it } from "@effect/vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliReadiness } from "./cli-readiness"

describe("CLI readiness", () => {
  it("acknowledges a pending launch only after the renderer loads", () => {
    const directory = mkdtempSync(join(tmpdir(), "diffdash-cli."))
    const readyPath = join(directory, "ready")

    try {
      const readiness = createCliReadiness()
      readiness.register([`--diffdash-cli-ready-v1=${readyPath}`])
      expect(existsSync(readyPath)).toBe(false)

      readiness.rendererLoaded()

      expect(readFileSync(readyPath, "utf8")).toBe("ready\n")
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it("immediately acknowledges a launch forwarded to an already-loaded renderer", () => {
    const directory = mkdtempSync(join(tmpdir(), "diffdash-cli."))
    const readyPath = join(directory, "ready")

    try {
      const readiness = createCliReadiness()
      readiness.rendererLoaded()
      readiness.register([`--diffdash-cli-ready-v1=${readyPath}`])

      expect(readFileSync(readyPath, "utf8")).toBe("ready\n")
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it("waits again when a loaded renderer is replaced or lost", () => {
    const directory = mkdtempSync(join(tmpdir(), "diffdash-cli."))
    const readyPath = join(directory, "ready")

    try {
      const readiness = createCliReadiness()
      readiness.rendererLoaded()
      readiness.rendererLoading()
      readiness.register([`--diffdash-cli-ready-v1=${readyPath}`])
      expect(existsSync(readyPath)).toBe(false)

      readiness.rendererLoaded()

      expect(readFileSync(readyPath, "utf8")).toBe("ready\n")
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it("accepts a private marker directory from a different temporary root", () => {
    const alternateRoot = mkdtempSync(join(tmpdir(), "diffdash-alternate-root-"))
    const directory = mkdtempSync(join(alternateRoot, "diffdash-cli."))
    const readyPath = join(directory, "ready")

    try {
      const readiness = createCliReadiness()
      readiness.rendererLoaded()
      readiness.register([`--diffdash-cli-ready-v1=${readyPath}`])

      expect(readFileSync(readyPath, "utf8")).toBe("ready\n")
    } finally {
      rmSync(alternateRoot, { force: true, recursive: true })
    }
  })

  it("ignores marker paths outside private DiffDash temporary directories", () => {
    const readiness = createCliReadiness()
    const unsafePath = join(tmpdir(), "diffdash-cli-ready")

    readiness.register([`--diffdash-cli-ready-v1=${unsafePath}`])
    readiness.rendererLoaded()

    expect(existsSync(unsafePath)).toBe(false)
  })
})
