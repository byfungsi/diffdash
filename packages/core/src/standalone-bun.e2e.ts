import * as DatabaseBun from "@diffdash/persistence/database-bun"

import { e2eProviderComposition } from "./provider-composition.e2e"
import { e2eCoreEventDeliveryTransform } from "./core-event-hub.e2e"
import { runStandaloneCoreProcess } from "./standalone-process"

runStandaloneCoreProcess(DatabaseBun.layer, e2eProviderComposition, e2eCoreEventDeliveryTransform)
