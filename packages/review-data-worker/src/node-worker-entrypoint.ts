import { parentPort } from "node:worker_threads"

import { attachReviewDataWorker, type ReviewDataWorkerEndpoint } from "./worker-endpoint"
import { isReviewDataWorkerCommand, type ReviewDataWorkerCommand } from "./worker-runtime"

if (parentPort === null) throw new Error("Review data worker requires a Node parent port")
const port = parentPort

const endpoint: ReviewDataWorkerEndpoint = {
  onCommand: (listener) => {
    const receive = (command: ReviewDataWorkerCommand): void => {
      if (isReviewDataWorkerCommand(command)) listener(command)
      else port.close()
    }
    port.on("message", receive)
    return () => port.off("message", receive)
  },
  respond: (response) => port.postMessage(response),
  close: () => port.close(),
}

attachReviewDataWorker(endpoint, {
  append: async () => undefined,
  close: async () => undefined,
})
