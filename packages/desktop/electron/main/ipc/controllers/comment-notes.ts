import { CoreMethod } from "@diffdash/core"

import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines collected comment-note IPC handlers over cohesive Core operations. */
export const defineCommentNoteHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.defineCore(CoreMethod.listCommentNotes, runtime.core.listCommentNotes)
  handlers.defineCore(CoreMethod.createCommentNote, runtime.core.createCommentNote)
  handlers.defineCore(CoreMethod.deleteCommentNote, runtime.core.deleteCommentNote)
  handlers.defineCore(CoreMethod.clearCommentNotes, runtime.core.clearCommentNotes)
  handlers.defineCore(CoreMethod.sendCommentNotes, runtime.core.sendCommentNotes)
}
