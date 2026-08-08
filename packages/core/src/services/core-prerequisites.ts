import { Option } from "effect"

import type { CoreConfiguration } from "../core-configuration"
import { Prerequisites } from "./prerequisites"

/** Converts normalized Core configuration to the existing prerequisite service input. */
export const corePrerequisitesOptions = (configuration: CoreConfiguration) => ({
  appImagePath: Option.getOrNull(configuration.paths.appImageOption),
  diffDashCliPath: configuration.paths.diffDashCli,
  executableSearchPath: configuration.environment.executableSearchPath,
  executablePathExtensions: Option.getOrNull(
    configuration.environment.executablePathExtensionsOption,
  ),
  homeDirectory: Option.getOrNull(configuration.environment.homeDirectoryOption),
  platform: configuration.application.platform,
})

/** Builds prerequisite services from normalized Core configuration. */
export const createCorePrerequisitesLayer = (configuration: CoreConfiguration) =>
  Prerequisites.layer(corePrerequisitesOptions(configuration))
