import {
  CommentNote,
  CommentNoteId,
  commentNoteContextKey,
  MAX_COMMENT_NOTES_PER_PROJECT,
} from "@diffdash/domain/comment-note"
import type {
  ClearCommentNotesRequest,
  CreateCommentNoteRequest,
  DeleteCommentNoteRequest,
  ListCommentNotesRequest,
} from "@diffdash/protocol/comment-notes"
import { Schema } from "effect"

const StoredCloudNote = Schema.Struct({
  note: CommentNote,
  projectId: Schema.String,
  contextKey: Schema.String,
})
const StoredCloudNotes = Schema.Array(StoredCloudNote)
const databaseName = "diffdash-cloud-notes-v1"
const storeName = "notes"

/** Safe browser-local note persistence failure, without source text or credentials. */
export class CloudCommentNotesError extends Schema.TaggedError<CloudCommentNotesError>()(
  "CloudCommentNotesError",
  {
    message: Schema.String,
  },
) {}

const storageFailure = () =>
  new CloudCommentNotesError({
    message:
      "Could not save or load browser notes. Check browser storage permissions and available space.",
  })

const openNotesDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.addEventListener("upgradeneeded", () => {
      const store = request.result.createObjectStore(storeName, { keyPath: "note.id" })
      store.createIndex("project", "projectId")
      store.createIndex("collection", ["projectId", "contextKey"])
    })
    request.addEventListener("success", () => resolve(request.result))
    request.addEventListener("error", () => reject(storageFailure()))
  })

const noteRequest = <Value>(request: IDBRequest<Value>): Promise<Value> =>
  new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result))
    request.addEventListener("error", () => reject(storageFailure()))
  })

const withNotesTransaction = async <Value>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<Value>,
): Promise<Value> => {
  const database = await openNotesDatabase()
  try {
    const transaction = database.transaction(storeName, mode)
    const complete = new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve())
      transaction.addEventListener("abort", () => reject(storageFailure()))
      transaction.addEventListener("error", () => reject(storageFailure()))
    })
    const [result] = await Promise.all([operation(transaction.objectStore(storeName)), complete])
    return result
  } finally {
    database.close()
  }
}

const collectionKey = (request: ListCommentNotesRequest) => [
  request.projectId,
  commentNoteContextKey(request.context),
]

/** IndexedDB-backed review note collections, isolated by project and review context. */
export class CloudCommentNotes {
  /** Loads notes in creation order, decoding persisted records at the storage boundary. */
  async list(request: ListCommentNotesRequest): Promise<readonly CommentNote[]> {
    return withNotesTransaction("readonly", async (store) => {
      const result: IDBRequest<Schema.Json[]> = store
        .index("collection")
        .getAll(collectionKey(request))
      return Schema.decodeUnknownSync(StoredCloudNotes)(await noteRequest(result))
        .map(({ note }) => note)
        .toSorted(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        )
    })
  }

  /** Atomically enforces the project note limit and persists one schema-encoded note. */
  async create(request: CreateCommentNoteRequest): Promise<CommentNote> {
    const note = CommentNote.make({
      id: CommentNoteId.make(crypto.randomUUID()),
      projectId: request.projectId,
      subject: request.subject,
      body: request.body,
      createdAt: new Date().toISOString(),
    })
    return withNotesTransaction("readwrite", async (store) => {
      const count = await noteRequest(store.index("project").count(request.projectId))
      if (count >= MAX_COMMENT_NOTES_PER_PROJECT)
        throw new CloudCommentNotesError({
          message:
            "This project has reached the note limit. Copy and clear some notes before adding more.",
        })
      await noteRequest(
        store.add(
          Schema.encodeUnknownSync(StoredCloudNote)({
            note,
            projectId: request.projectId,
            contextKey: commentNoteContextKey(request.context),
          }),
        ),
      )
      return note
    })
  }

  /** Deletes only a note belonging to the requested project and review context. */
  async delete(request: DeleteCommentNoteRequest): Promise<void> {
    await withNotesTransaction("readwrite", async (store) => {
      const result: IDBRequest<Schema.Json | undefined> = store.get(request.noteId)
      const value = await noteRequest(result)
      if (value === undefined) return
      const record = Schema.decodeUnknownSync(StoredCloudNote)(value)
      if (
        record.projectId !== request.projectId ||
        record.contextKey !== commentNoteContextKey(request.context)
      )
        return
      await noteRequest(store.delete(request.noteId))
    })
  }

  /** Atomically clears the current review collection without touching other reviews. */
  async clear(request: ClearCommentNotesRequest): Promise<void> {
    await withNotesTransaction("readwrite", async (store) => {
      const keys = await noteRequest(store.index("collection").getAllKeys(collectionKey(request)))
      await Promise.all(keys.map((key) => noteRequest(store.delete(key))))
    })
  }
}
