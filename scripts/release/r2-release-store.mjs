import { execFileSync } from "node:child_process"

import { runSyncCommand } from "./release-command.mjs"

const immutableCacheControl = "public, max-age=31536000, immutable"
const latestCacheControl = "public, max-age=60"
const stableCacheControl = "no-store"

/** Internal AWS CLI adapter for immutable release candidates and mutable public pointers. */
export class R2ReleaseStore {
  #bucket
  #endpoint
  #environment
  #execute
  #run

  constructor(
    { bucket, endpoint, awsEnvironment },
    { execute = execFileSync, run = runSyncCommand } = {},
  ) {
    this.#bucket = bucket
    this.#endpoint = endpoint
    this.#environment = awsEnvironment
    this.#execute = execute
    this.#run = run
  }

  listCandidateKeys(tag) {
    return this.#json([
      "s3api",
      "list-objects-v2",
      "--bucket",
      this.#bucket,
      "--prefix",
      `releases/${tag}/`,
      "--query",
      "Contents[].Key",
      "--output",
      "json",
    ])
  }

  headCandidate(tag, name) {
    return this.#json([
      "s3api",
      "head-object",
      "--bucket",
      this.#bucket,
      "--key",
      `releases/${tag}/${name}`,
      "--output",
      "json",
    ])
  }

  downloadCandidate(tag, name, destination) {
    this.#runAws(["s3", "cp", this.#candidateUrl(tag, name), destination])
  }

  uploadCandidate(tag, name, source, sha256) {
    this.#runAws([
      "s3",
      "cp",
      source,
      this.#candidateUrl(tag, name),
      "--cache-control",
      immutableCacheControl,
      "--metadata",
      `sha256=${sha256}`,
    ])
  }

  copyCandidateLatestToPointer(tag) {
    this.#runAws([
      "s3",
      "cp",
      this.#candidateUrl(tag, "latest.json"),
      this.#pointerUrl("latest.json"),
      "--cache-control",
      latestCacheControl,
      "--content-type",
      "application/json",
    ])
  }

  uploadPointer(name, source) {
    this.#runAws([
      "s3",
      "cp",
      source,
      this.#pointerUrl(name),
      "--cache-control",
      this.#pointerCacheControl(name),
      "--content-type",
      "application/json",
    ])
  }

  backupPointer(name, backupPath) {
    const count = this.#text([
      "s3api",
      "list-objects-v2",
      "--bucket",
      this.#bucket,
      "--prefix",
      name,
      "--query",
      `length(Contents[?Key=='${name}'])`,
      "--output",
      "text",
    ]).replace(/\r?\n$/u, "")
    if (count === "0") return Object.freeze({ name, backupPath, existed: false })
    if (count !== "1") throw new Error(`Could not determine the existing R2 ${name} pointer.`)
    this.#execute(
      "aws",
      ["s3", "cp", this.#pointerUrl(name), backupPath, "--endpoint-url", this.#endpoint],
      { env: this.#environment, stdio: "ignore" },
    )
    return Object.freeze({ name, backupPath, existed: true })
  }

  restorePointer({ name, backupPath, existed }) {
    if (!existed) {
      this.#runAws(["s3", "rm", this.#pointerUrl(name)])
      return
    }
    this.uploadPointer(name, backupPath)
  }

  listReleasePrefixes() {
    return this.#json([
      "s3api",
      "list-objects-v2",
      "--bucket",
      this.#bucket,
      "--prefix",
      "releases/",
      "--delimiter",
      "/",
      "--query",
      "CommonPrefixes[].Prefix",
      "--output",
      "json",
    ])
  }

  deleteReleasePrefix(prefix) {
    this.#runAws(["s3", "rm", `s3://${this.#bucket}/${prefix}`, "--recursive"])
  }

  #candidateUrl(tag, name) {
    return `s3://${this.#bucket}/releases/${tag}/${name}`
  }

  #pointerUrl(name) {
    return `s3://${this.#bucket}/${name}`
  }

  #pointerCacheControl(name) {
    return name === "stable.json" ? stableCacheControl : latestCacheControl
  }

  #runAws(args) {
    this.#run("aws", [...args, "--endpoint-url", this.#endpoint], {
      env: this.#environment,
    })
  }

  #json(args) {
    return JSON.parse(this.#text(args) || "[]") ?? []
  }

  #text(args) {
    return this.#execute("aws", [...args, "--endpoint-url", this.#endpoint], {
      encoding: "utf8",
      env: this.#environment,
    })
  }
}
