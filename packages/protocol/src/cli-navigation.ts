import { Schema } from "effect"

import {
  GitProviderId,
  HostedRepositoryName,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"

/** Absolute checkout path accepted from a native CLI invocation. */
export const CliRepositoryPath = RepositoryCheckoutPath

/** Absolute checkout path accepted from a native CLI invocation. */
export type CliRepositoryPath = typeof CliRepositoryPath.Type

/** Maximum commands returned by one transactional renderer drain. */
export const NAVIGATION_COMMAND_DRAIN_LIMIT = 32

/** Open one local checkout as a project workspace. */
export class OpenProjectCommand extends Schema.TaggedClass<OpenProjectCommand>()("openProject", {
  localPath: CliRepositoryPath,
}) {}

/** Open working-tree changes for a legacy private integration. */
export class OpenWorkingTreeCommand extends Schema.TaggedClass<OpenWorkingTreeCommand>()(
  "openWorkingTree",
  { localPath: CliRepositoryPath },
) {}

/** Save a local checkout as a favorite repository. */
export class LinkRepositoryCommand extends Schema.TaggedClass<LinkRepositoryCommand>()(
  "linkRepository",
  { localPath: CliRepositoryPath },
) {}

/** Open a repository's PR list or one numbered pull request. */
export class OpenPullRequestCommand extends Schema.TaggedClass<OpenPullRequestCommand>()(
  "openPullRequest",
  {
    localPath: CliRepositoryPath,
    number: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  },
) {}

/** Open local changes compared with an explicit revision or the default branch. */
export class OpenBranchDiffCommand extends Schema.TaggedClass<OpenBranchDiffCommand>()(
  "openBranchDiff",
  {
    localPath: CliRepositoryPath,
    branchName: Schema.NullOr(RepositoryComparisonRef),
  },
) {}

/** Open the checkout's current HEAD commit compared with its first parent. */
export class OpenLastCommitCommand extends Schema.TaggedClass<OpenLastCommitCommand>()(
  "openLastCommit",
  { localPath: CliRepositoryPath },
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
    localPath: CliRepositoryPath,
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
  OpenLastCommitCommand,
  OpenRepositoryComparisonCommand,
  RepairRepositoryIdentitiesCommand,
  CliNavigationErrorCommand,
])

/** One command forwarded by a DiffDash launcher to the running desktop app. */
export type CliNavigationCommand = typeof CliNavigationCommand.Type
