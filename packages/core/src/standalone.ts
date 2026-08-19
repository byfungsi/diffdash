import * as DatabaseNode from "@diffdash/persistence/database-node"

import { runStandaloneCoreProcess } from "./standalone-process"

runStandaloneCoreProcess(DatabaseNode.layer)
