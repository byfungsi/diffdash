import { isAbsolute, resolve } from "node:path"

import {
  CliNavigationErrorCommand,
  LinkRepositoryCommand,
  OpenBranchDiffCommand,
  OpenPullRequestCommand,
  OpenWorkingTreeCommand,
  type CliNavigationCommand,
} from "../../src/shared/cli-navigation"

/** Private argv sentinel used by update-safe DiffDash launchers. */
export const DIFFDASH_CLI_ARG = "--diffdash-cli-v1"
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

const parsePublicCommand = (args: readonly string[], cwd: string): CliNavigationCommand => {
  const command = args[0]
  if (command === "install") {
    const error = validateOptionalArgument(args, "diffdash install [path]")
    return error ?? LinkRepositoryCommand.make({ localPath: resolve(cwd, args[1] ?? ".") })
  }

  if (command === "pr") {
    const error = validateOptionalArgument(args, "diffdash pr [pr-number]")
    if (error !== null) return error
    const rawNumber = args[1]
    if (rawNumber === undefined) {
      return OpenPullRequestCommand.make({ localPath: resolve(cwd), number: null })
    }
    const number = Number(rawNumber)
    if (!Number.isSafeInteger(number) || number <= 0) {
      return cliError(
        "Pull request number must be a positive integer.\nUsage: diffdash pr [pr-number]",
      )
    }
    return OpenPullRequestCommand.make({ localPath: resolve(cwd), number })
  }

  if (command === "diff") {
    const error = validateOptionalArgument(args, "diffdash diff [branch-name]")
    if (error !== null) return error
    return OpenBranchDiffCommand.make({
      localPath: resolve(cwd),
      branchName: args[1] ?? null,
    })
  }

  if (args.length > 1) {
    return cliError("diffdash accepts at most one path.\nUsage: diffdash [path]")
  }
  if (command?.startsWith("-") === true) {
    return cliError(`Unknown option: ${command}\nUsage: diffdash [path]`)
  }
  return OpenWorkingTreeCommand.make({ localPath: resolve(cwd, command ?? ".") })
}

const validateOptionalArgument = (
  args: readonly string[],
  usage: string,
): CliNavigationErrorCommand | null => {
  const argument = args[1]
  if (argument?.startsWith("-") === true) {
    return cliError(`Unknown option: ${argument}\nUsage: ${usage}`)
  }
  return args.length > 2 ? cliError(`Too many arguments.\nUsage: ${usage}`) : null
}

const cliError = (message: string) => CliNavigationErrorCommand.make({ message })

const parseLegacyPathArg = (argv: readonly string[], cwd: string, argumentName: string) => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === argumentName) {
      const value = argv[index + 1]
      return value === undefined ? null : resolve(cwd, value)
    }
    const prefix = `${argumentName}=`
    if (argument?.startsWith(prefix) === true) return resolve(cwd, argument.slice(prefix.length))
  }
  return null
}
