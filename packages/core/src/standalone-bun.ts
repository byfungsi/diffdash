import * as DatabaseBun from "@diffdash/persistence/database-bun"

import { runStandaloneCoreProcess } from "./standalone-process"

runStandaloneCoreProcess(DatabaseBun.layer)
