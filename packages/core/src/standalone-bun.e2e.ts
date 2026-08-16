import * as DatabaseBun from "@diffdash/persistence/database-bun"

import { e2eProviderComposition } from "./provider-composition.e2e"
import { runStandaloneCoreProcess } from "./standalone-process"

runStandaloneCoreProcess(DatabaseBun.layer, e2eProviderComposition)
