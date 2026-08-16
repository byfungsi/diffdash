import * as DatabaseNode from "@diffdash/persistence/database-node"

import { e2eProviderComposition } from "./provider-composition.e2e"
import { runStandaloneCoreProcess } from "./standalone-process"

runStandaloneCoreProcess(DatabaseNode.layer, e2eProviderComposition)
