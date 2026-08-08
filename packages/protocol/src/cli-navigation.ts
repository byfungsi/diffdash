import { Schema } from "effect"

import {
  GitProviderId,
  HostedRepositoryName,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"

/** Maximum commands returned by one transactional renderer drain. */
export const NAVIGATION_COMMAND_DRAIN_LIMIT = 32

/** Open one local checkout as a project workspace. */
export class OpenProjectCommand extends Schema.TaggedClass<OpenProjectCommand>()("openProject", {
  localPath: Schema.NonEmptyString,
}) {}

/** Open working-tree changes for a legacy private integration. */
export class OpenWorkingTreeCommand extends Schema.TaggedClass<OpenWorkingTreeCommand>()(
  "openWorkingTree",
  { localPath: Schema.NonEmptyString },
) {}

/** Save a local checkout as a favorite repository. */
export class LinkRepositoryCommand extends Schema.TaggedClass<LinkRepositoryCommand>()(
  "linkRepository",
  { localPath: Schema.NonEmptyString },
) {}

/** Open a repository's PR list or one numbered pull request. */
export class OpenPullRequestCommand extends Schema.TaggedClass<OpenPullRequestCommand>()(
  "openPullRequest",
  {
    localPath: Schema.NonEmptyString,
    number: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  },
) {}

/** Open local changes compared with an explicit or default branch. */
export class OpenBranchDiffCommand extends Schema.TaggedClass<OpenBranchDiffCommand>()(
  "openBranchDiff",
  {
    localPath: Schema.NonEmptyString,
    branchName: Schema.NullOr(Schema.NonEmptyString),
  },
) {}

/** Hosted repository selector supplied by a public CLI invocation. */
export class CliRepositorySelector extends Schema.Class<CliRepositorySelector>(
  "CliRepositorySelector",
)({
  providerId: Schema.NullOr(GitProviderId),
  namespace: RepositoryNamespace,
  name: HostedRepositoryName,
}) {}

/** Safe branch, tag, or full commit input accepted by the public CLI. */
export const CliGitRevision = RepositoryComparisonRef

/** Safe branch, tag, or full commit input accepted by the public CLI. */
export type CliGitRevision = RepositoryComparisonRef

/** Open an immutable comparison from the invocation checkout or an explicit saved repository. */
export class OpenRepositoryComparisonCommand extends Schema.TaggedClass<OpenRepositoryComparisonCommand>()(
  "openRepositoryComparison",
  {
    localPath: Schema.NonEmptyString,
    repository: Schema.NullOr(CliRepositorySelector),
    baseRef: CliGitRevision,
    headRef: CliGitRevision,
  },
) {}

/** Run one resumable repository identity repair pass. */
export class RepairRepositoryIdentitiesCommand extends Schema.TaggedClass<RepairRepositoryIdentitiesCommand>()(
  "repairRepositoryIdentities",
  {},
) {}

/** Surface invalid CLI syntax in the desktop application. */
export class CliNavigationErrorCommand extends Schema.TaggedClass<CliNavigationErrorCommand>()(
  "error",
  { message: Schema.NonEmptyString },
) {}

/** One command forwarded by a DiffDash launcher to the running desktop app. */
export const CliNavigationCommand = Schema.Union([
  OpenProjectCommand,
  OpenWorkingTreeCommand,
  LinkRepositoryCommand,
  OpenPullRequestCommand,
  OpenBranchDiffCommand,
  OpenRepositoryComparisonCommand,
  RepairRepositoryIdentitiesCommand,
  CliNavigationErrorCommand,
])

/** One command forwarded by a DiffDash launcher to the running desktop app. */
export type CliNavigationCommand = typeof CliNavigationCommand.Type
