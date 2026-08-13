import { isAbsolute, resolve } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect, Match, Option, Schema } from "effect"
import { Argument, CliError, CliOutput, Command, Flag } from "effect/unstable/cli"

import {
  CliRepositoryPath,
  CliGitRevision,
  CliNavigationErrorCommand,
  CliRepositorySelector,
  LinkRepositoryCommand,
  OpenBranchDiffCommand,
  OpenLastCommitCommand,
  OpenProjectCommand,
  OpenPullRequestCommand,
  OpenRepositoryComparisonCommand,
  OpenWorkingTreeCommand,
  RepairRepositoryIdentitiesCommand,
  type CliNavigationCommand,
} from "@diffdash/protocol/cli-navigation"

/** Private argv sentinel used by update-safe DiffDash launchers. */
const DIFFDASH_CLI_ARG = "--diffdash-cli-v1"
const DIFFDASH_CLI_ARG_PREFIX = `${DIFFDASH_CLI_ARG}=`

const LOCAL_REVIEW_ARG = "--diffdash-local-path"
const LINK_REPOSITORY_ARG = "--diffdash-link-path"

/** Parses one public or legacy DiffDash CLI invocation from Electron argv. */
export const parseCliNavigationCommand = (
  argv: readonly string[],
  fallbackCwd: string,
): CliNavigationCommand | null => {
  const inlineSentinelIndex = argv.findIndex((argument) =>
    argument.startsWith(DIFFDASH_CLI_ARG_PREFIX),
  )
  if (inlineSentinelIndex >= 0) {
    const argument = argv[inlineSentinelIndex]
    const cwd = argument?.slice(DIFFDASH_CLI_ARG_PREFIX.length) || fallbackCwd
    return parsePublicCommand(parsePublicArguments(argv, inlineSentinelIndex, 1), cwd)
  }

  const sentinelIndex = argv.indexOf(DIFFDASH_CLI_ARG)
  if (sentinelIndex >= 0) {
    const separatorIndex = argv.indexOf("--", sentinelIndex + 2)
    const cwd = parseLegacyEnvelopeCwd(argv, sentinelIndex, separatorIndex) ?? fallbackCwd
    return parsePublicCommand(parsePublicArguments(argv, sentinelIndex, 2), cwd)
  }

  const repositoryLinkPath = parseLegacyPathArg(argv, fallbackCwd, LINK_REPOSITORY_ARG)
  if (repositoryLinkPath !== null) {
    return LinkRepositoryCommand.make({ localPath: repositoryLinkPath })
  }

  const localReviewPath = parseLegacyPathArg(argv, fallbackCwd, LOCAL_REVIEW_ARG)
  return localReviewPath === null
    ? null
    : OpenWorkingTreeCommand.make({ localPath: localReviewPath })
}

const parsePublicArguments = (
  argv: readonly string[],
  sentinelIndex: number,
  argumentsOffset: number,
) => {
  const separatorIndex = argv.indexOf("--", sentinelIndex + 1)
  return separatorIndex < 0
    ? argv.slice(sentinelIndex + argumentsOffset)
    : argv.slice(separatorIndex + 1)
}

const parseLegacyEnvelopeCwd = (
  argv: readonly string[],
  sentinelIndex: number,
  separatorIndex: number,
) => {
  if (separatorIndex < 0) return argv[sentinelIndex + 1]

  // Electron may group Chromium switches ahead of positional arguments for a second instance.
  for (let index = separatorIndex - 1; index > sentinelIndex; index -= 1) {
    const argument = argv[index]
    if (argument !== undefined && isAbsolute(argument)) return argument
  }
  return undefined
}

const cliError = (message: string) => CliNavigationErrorCommand.make({ message })

const parsePublicCommand = (args: readonly string[], cwd: string): CliNavigationCommand | null => {
  const compatibilityError = validatePublicArgumentCompatibility(args)
  if (compatibilityError !== null) return compatibilityError
  let result: CliNavigationCommand | null = null
  const select = (command: CliNavigationCommand) =>
    Effect.sync(() => {
      result = command
    })

  const optionalPath = Argument.string("path").pipe(Argument.optional)
  const install = Command.make("install", { path: optionalPath }, ({ path }) =>
    select(
      LinkRepositoryCommand.make({
        localPath: CliRepositoryPath.make(
          resolve(
            cwd,
            Option.getOrElse(path, () => "."),
          ),
        ),
      }),
    ),
  ).pipe(Command.withDescription("Save a local Git repository in DiffDash"))
  const pullRequestNumber = Argument.string("pr-number").pipe(
    Argument.mapTryCatch(
      (input) => {
        const number = Number(input)
        if (!Number.isSafeInteger(number) || number <= 0) throw new Error("invalid PR number")
        return number
      },
      () => "Pull request number must be a positive integer.",
    ),
    Argument.optional,
  )
  const pullRequest = Command.make("pr", { number: pullRequestNumber }, ({ number }) =>
    select(
      OpenPullRequestCommand.make({
        localPath: CliRepositoryPath.make(resolve(cwd)),
        number: Option.getOrNull(number),
      }),
    ),
  ).pipe(Command.withDescription("Open a repository's pull requests"))
  const branch = gitRevisionArgument("branch").pipe(Argument.optional)
  const diff = Command.make("diff", { branch }, ({ branch: branchName }) =>
    select(
      OpenBranchDiffCommand.make({
        localPath: CliRepositoryPath.make(resolve(cwd)),
        branchName: Option.getOrNull(branchName),
      }),
    ),
  ).pipe(Command.withDescription("Open local changes against a branch"))
  const lastCommit = Command.make("last-commit", {}, () =>
    select(
      OpenLastCommitCommand.make({
        localPath: CliRepositoryPath.make(resolve(cwd)),
      }),
    ),
  ).pipe(
    Command.withAlias("lc"),
    Command.withDescription("Open the last commit against its first parent"),
  )
  const baseRef = gitRevisionArgument("base")
  const headRef = gitRevisionArgument("head")
  const repository = Flag.string("repository").pipe(
    Flag.mapTryCatch(
      (input) => {
        const selector = parseRepositorySelector(input)
        if (selector === null) throw new Error("invalid repository selector")
        return selector
      },
      () => "Repository must be provider:namespace/name or namespace/name.",
    ),
    Flag.withDescription("Saved repository to compare"),
    Flag.optional,
  )
  const compare = Command.make(
    "compare",
    { baseRef, headRef, repository },
    ({ baseRef: parsedBaseRef, headRef: parsedHeadRef, repository: parsedRepository }) =>
      select(
        OpenRepositoryComparisonCommand.make({
          localPath: CliRepositoryPath.make(resolve(cwd)),
          repository: Option.getOrNull(parsedRepository),
          baseRef: parsedBaseRef,
          headRef: parsedHeadRef,
        }),
      ),
  ).pipe(Command.withDescription("Open an immutable repository comparison"))
  const repair = Command.make("repair", {}, () =>
    select(RepairRepositoryIdentitiesCommand.make({})),
  ).pipe(Command.withDescription("Repair saved repository identities"))
  const root = Command.make("diffdash", { path: optionalPath }, ({ path }) =>
    select(
      OpenProjectCommand.make({
        localPath: CliRepositoryPath.make(
          resolve(
            cwd,
            Option.getOrElse(path, () => "."),
          ),
        ),
      }),
    ),
  ).pipe(
    Command.withDescription("Desktop code review for local and hosted Git repositories"),
    Command.withSubcommands([install, pullRequest, diff, lastCommit, compare, repair]),
  )

  const normalizedArgs = normalizePublicArguments(args)
  const formatter = CliOutput.defaultFormatter({ colors: false })
  const program = Command.runWith(root, { version: "0.0.0" })(normalizedArgs).pipe(
    Effect.catch((error) => {
      return Match.type<CliError.CliError>().pipe(
        Match.when(Schema.is(CliError.ShowHelp), (help) => {
          if (help.errors.length === 0) return Effect.void
          return select(
            cliError(
              help.errors
                .map((reportedError) =>
                  Match.value(reportedError).pipe(
                    Match.when(
                      Schema.is(CliError.MissingArgument),
                      (missing) => `Missing argument <${missing.argument}>`,
                    ),
                    Match.orElse((value) => formatter.formatCliError(value)),
                  ),
                )
                .join("\n") || "Invalid command.",
            ),
          )
        }),
        Match.orElse((value) =>
          select(cliError(formatter.formatCliError(value) || "Invalid command.")),
        ),
      )(error)
    }),
    silenceConsole,
    Effect.provide(NodeServices.layer),
  )
  Effect.runSync(program)
  return result
}

const gitRevisionArgument = (name: "base" | "branch" | "head") =>
  Argument.string(name).pipe(
    Argument.mapTryCatch(
      (input) => CliGitRevision.make(input),
      () => `Invalid ${name} revision.`,
    ),
  )

const normalizePublicArguments = (args: readonly string[]): readonly string[] => {
  if (args[0] !== "compare") return args
  const options: string[] = []
  const positionals: string[] = []
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === "--repository") {
      options.push(argument)
      const value = args[index + 1]
      if (value !== undefined) {
        options.push(value)
        index += 1
      }
    } else if (argument.startsWith("-")) {
      options.push(argument)
    } else {
      positionals.push(argument)
    }
  }
  return ["compare", ...options, ...positionals]
}

const comparisonPositionalCount = (args: readonly string[]) => {
  if (args[0] !== "compare") return 0
  let count = 0
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--repository") {
      index += 1
    } else if (argument?.startsWith("-") !== true) {
      count += 1
    }
  }
  return count
}

const validatePublicArgumentCompatibility = (
  args: readonly string[],
): CliNavigationErrorCommand | null => {
  if (args[0] !== "compare") {
    const unsupportedOption = args.find(
      (argument) => argument.startsWith("-") && argument !== "--help" && argument !== "-h",
    )
    if (unsupportedOption !== undefined) {
      return cliError(`Unrecognized option '${unsupportedOption}'.`)
    }
    const maximumArguments = args[0] === "install" || args[0] === "pr" || args[0] === "diff" ? 2 : 1
    return args.length > maximumArguments ? cliError("Too many arguments.") : null
  }
  let repositoryOptions = 0
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === "--repository" || argument.startsWith("--repository=")) {
      repositoryOptions += 1
      if (argument === "--repository" && args[index + 1] === undefined) {
        return cliError("Option '--repository' requires a value.")
      }
    } else if (argument === "--help" || argument === "-h") {
      continue
    } else if (argument.startsWith("-")) {
      return cliError(`Unrecognized option '${argument}'.`)
    }
  }
  if (repositoryOptions > 1) {
    return cliError("Option '--repository' may only be specified once.")
  }
  return comparisonPositionalCount(args) > 2
    ? cliError("Received an unexpected comparison argument.")
    : null
}

const silenceConsole = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideService(program, Console.Console, {
    ...console,
    error: () => undefined,
    log: () => undefined,
  })

const parseRepositorySelector = (input: string): CliRepositorySelector | null => {
  const separator = input.indexOf(":")
  const providerInput = separator < 0 ? null : input.slice(0, separator)
  const repositoryInput = separator < 0 ? input : input.slice(separator + 1)
  const segments = repositoryInput.split("/")
  const name = segments.pop()
  const namespace = segments.join("/")
  if (
    (providerInput !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerInput)) ||
    providerInput === "local" ||
    namespace.length === 0 ||
    name === undefined ||
    name.length === 0 ||
    !/^[^/:#%]+(?:\/[^/:#%]+)*$/.test(namespace) ||
    !/^[^/:#%]+$/.test(name)
  ) {
    return null
  }

  return Schema.decodeUnknownSync(CliRepositorySelector)({
    providerId: providerInput,
    namespace,
    name,
  })
}

/** Reports whether a queued command explicitly requests repository identity repair. */
export const hasRepositoryIdentityRepairCommand = (commands: readonly CliNavigationCommand[]) =>
  commands.some((command) =>
    Match.value(command).pipe(
      Match.when({ _tag: "repairRepositoryIdentities" }, () => true),
      Match.orElse(() => false),
    ),
  )

const parseLegacyPathArg = (argv: readonly string[], cwd: string, argumentName: string) => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === argumentName) {
      const value = argv[index + 1]
      return value === undefined ? null : CliRepositoryPath.make(resolve(cwd, value))
    }
    const prefix = `${argumentName}=`
    if (argument?.startsWith(prefix) === true) {
      return CliRepositoryPath.make(resolve(cwd, argument.slice(prefix.length)))
    }
  }
  return null
}
