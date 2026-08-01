import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Absolute demo-video package root. */
export const demoVideoPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Absolute DiffDash workspace root. */
export const demoWorkspaceRoot = resolve(demoVideoPackageRoot, "../..")

/** Root containing one generated directory per registered story. */
export const demoOutputRoot = resolve(demoVideoPackageRoot, "output")
