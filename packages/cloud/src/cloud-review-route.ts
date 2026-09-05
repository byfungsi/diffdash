import { HostedRepositoryName, RepositoryNamespace } from "@diffdash/domain/git-provider"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { Schema } from "effect"

/** Safe URL failure shown without falling back to an unrelated repository or review. */
export class CloudReviewRouteError extends Schema.TaggedError<CloudReviewRouteError>()(
  "CloudReviewRouteError",
  { message: Schema.String },
) {}

const repositoryFields = { owner: RepositoryNamespace, repo: HostedRepositoryName }
const CloudReviewRouteSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("home") }),
  Schema.Struct({ kind: Schema.Literal("repository"), ...repositoryFields }),
  Schema.Struct({
    kind: Schema.Literal("pull"),
    ...repositoryFields,
    number: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    view: Schema.Literals(["overview", "files"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    ...repositoryFields,
    ref: RepositoryComparisonRef,
  }),
  Schema.Struct({
    kind: Schema.Literal("compare"),
    ...repositoryFields,
    base: RepositoryComparisonRef,
    head: RepositoryComparisonRef,
  }),
])

/** Parsed GitHub-compatible core review route; query and fragment navigation are deferred. */
export type CloudReviewRoute = typeof CloudReviewRouteSchema.Type

/** Parses GitHub path syntax, including slash-containing and percent-encoded comparison refs. */
export const parseCloudReviewRoute = (pathname: string): CloudReviewRoute => {
  if (pathname === "/") return { kind: "home" }
  try {
    const match = /^\/([^/]+)\/([^/]+)(?:\/(.*))?$/u.exec(pathname.replace(/\/$/u, ""))
    if (match === null) throw new Error("route")
    const owner = decodeURIComponent(match[1] ?? "")
    const repo = decodeURIComponent(match[2] ?? "")
    if (owner.includes("/") || repo.includes("/")) throw new Error("segment")
    const rest = match[3] ?? ""
    const decode = Schema.decodeUnknownSync(CloudReviewRouteSchema)
    if (rest === "" || rest === "pulls") return decode({ kind: "repository", owner, repo })
    const pull = /^pull\/([1-9]\d*)(?:\/(files))?$/u.exec(rest)
    if (pull !== null) {
      const number = Number(pull[1])
      if (!Number.isSafeInteger(number)) throw new Error("number")
      return decode({
        kind: "pull",
        owner,
        repo,
        number,
        view: pull[2] === "files" ? "files" : "overview",
      })
    }
    if (rest.startsWith("commit/")) {
      const ref = decodeURIComponent(rest.slice("commit/".length))
      if (!/^[0-9a-f]{7,40}$/iu.test(ref)) throw new Error("commit")
      return decode({ kind: "commit", owner, repo, ref })
    }
    if (rest.startsWith("compare/")) {
      const refs = decodeURIComponent(rest.slice("compare/".length)).split("...")
      if (refs.length === 2)
        return decode({ kind: "compare", owner, repo, base: refs[0], head: refs[1] })
    }
  } catch {
    throw new CloudReviewRouteError({
      message: "This GitHub review URL is invalid or not supported yet.",
    })
  }
  throw new CloudReviewRouteError({
    message:
      "This GitHub page is not supported yet. Open a pull request, commit, or base...head comparison.",
  })
}

/** Formats supported routes without changing GitHub's owner/repository path order. */
export const formatCloudReviewRoute = (route: CloudReviewRoute): string => {
  if (route.kind === "home") return "/"
  const prefix = `/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}`
  if (route.kind === "repository") return `${prefix}/pulls`
  if (route.kind === "pull")
    return `${prefix}/pull/${route.number}${route.view === "files" ? "/files" : ""}`
  if (route.kind === "commit") return `${prefix}/commit/${encodeURIComponent(route.ref)}`
  return `${prefix}/compare/${encodeURIComponent(route.base)}...${encodeURIComponent(route.head)}`
}
