import { attachReviewDataWorker, type ReviewDataWorkerEndpoint } from "./worker-endpoint"
import { isReviewDataWorkerCommand } from "./worker-runtime"

const endpoint: ReviewDataWorkerEndpoint = {
  onCommand: (listener) => {
    const receive = (event: MessageEvent): void => {
      if (isReviewDataWorkerCommand(event.data)) listener(event.data)
      else close()
    }
    addEventListener("message", receive)
    return () => removeEventListener("message", receive)
  },
  respond: (response) => postMessage(response),
  close: () => close(),
}

attachReviewDataWorker(endpoint, {
  append: async () => undefined,
  close: async () => undefined,
})
