import { resolve } from "node:path"

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

const LOCAL_REVIEW_ARG = "--diffdash-local-path"
const LINK_REPOSITORY_ARG = "--diffdash-link-path"

/** Parses one public or legacy DiffDash CLI invocation from Electron argv. */
export const parseCliNavigationCommand = (
  argv: readonly string[],
  fallbackCwd: string,
): CliNavigationCommand | null => {
  const sentinelIndex = argv.indexOf(DIFFDASH_CLI_ARG)
  if (sentinelIndex >= 0) {
    const cwd = argv[sentinelIndex + 1] ?? fallbackCwd
    const separatorIndex = argv.indexOf("--", sentinelIndex + 2)
    const args = separatorIndex < 0 ? argv.slice(sentinelIndex + 2) : argv.slice(separatorIndex + 1)
    return parsePublicCommand(args, cwd)
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
