import { DEFAULT_AI_SETTINGS, AISettings } from "@diffdash/domain/ai-settings"
import { AppState } from "@diffdash/domain/app-state"
import {
  HostedRepositorySource,
  makeHostedRepositoryKey,
  type HostedRepository,
} from "@diffdash/domain/git-provider"
import {
  ProjectWorkspaceState,
  type ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import { RemoteOnly, Repo } from "@diffdash/domain/repository"
import { makeReviewKey, ReviewProjectId, ViewedFileRecord } from "@diffdash/domain/review-identity"
import type {
  HostedViewedFilesRequest,
  SetHostedViewedFileRequest,
} from "@diffdash/protocol/viewed-files"
import { Schema } from "effect"

const CLOUD_DATABASE_NAME = "diffdash-cloud-v1"
const CLOUD_DATABASE_VERSION = 1
const SETTINGS_STORAGE_KEY = "diffdash.cloud.settings.v1"
const APP_STATE_STORAGE_KEY = "diffdash.cloud.app-state.v1"
const REPOSITORIES_STORE = "repositories"
const PROJECT_WORKSPACES_STORE = "projectWorkspaces"
const VIEWED_FILES_STORE = "viewedFiles"

const CloudAppState = AppState

/** Browser-local persistence for Cloud repositories, workspace navigation, and viewed files. */
export class CloudStorage {
  /** Loads locally remembered repositories ordered by most recent update. */
  async listRepositories(query?: string): Promise<readonly Repo[]> {
    const repositories = await getAllRecords(REPOSITORIES_STORE, Repo)
    const normalizedQuery = query?.trim().toLocaleLowerCase("en-US") ?? ""
    return repositories
      .filter(
        (repository) =>
          normalizedQuery.length === 0 ||
          repository.displayIdentity.toLocaleLowerCase("en-US").includes(normalizedQuery),
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** Creates or updates a remote-only repository bookmark. */
  async saveHostedRepository(repository: HostedRepository, isFavorite: boolean): Promise<Repo> {
    const id = ReviewProjectId.make(makeHostedRepositoryKey(repository.locator))
    const existing = await this.getRepository(id)
    const now = new Date().toISOString()
    const saved = Repo.make({
      id,
      source: HostedRepositorySource.make({ locator: repository.locator }),
      checkout: RemoteOnly.make({ remoteUrl: repository.url }),
      isFavorite: existing?.isFavorite === true || isFavorite,
      lastOpenedAt: existing?.lastOpenedAt ?? null,
      lastSyncedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    await putRecord(REPOSITORIES_STORE, id, Schema.encodeUnknownSync(Repo)(saved))
    return saved
  }

  /** Updates favorite intent for one remembered repository. */
  async setRepositoryFavorite(projectId: ReviewProjectId, isFavorite: boolean): Promise<Repo> {
    const repository = await this.requireRepository(projectId)
    const updated = Repo.make({
      ...repository,
      isFavorite,
      updatedAt: new Date().toISOString(),
    })
    await putRecord(REPOSITORIES_STORE, projectId, Schema.encodeUnknownSync(Repo)(updated))
    return updated
  }

  /** Removes one repository bookmark and its workspace state. */
  async forgetRepository(projectId: ReviewProjectId): Promise<Repo> {
    const repository = await this.requireRepository(projectId)
    await Promise.all([
      deleteRecord(REPOSITORIES_STORE, projectId),
      deleteRecord(PROJECT_WORKSPACES_STORE, projectId),
    ])
    return repository
  }

  /** Loads renderer settings from localStorage with schema parsing on reentry. */
  loadSettings(): AISettings {
    return loadLocalValue(SETTINGS_STORAGE_KEY, AISettings, DEFAULT_AI_SETTINGS)
  }

  /** Persists schema-encoded renderer settings in localStorage. */
  saveSettings(settings: AISettings): AISettings {
    saveLocalValue(SETTINGS_STORAGE_KEY, AISettings, settings)
    return settings
  }

  /** Loads Cloud app state, defaulting desktop onboarding to complete. */
  loadAppState(): AppState {
    return loadLocalValue(
      APP_STATE_STORAGE_KEY,
      CloudAppState,
      AppState.make({ onboardingCompleted: true }),
    )
  }

  /** Persists schema-encoded Cloud app state in localStorage. */
  saveAppState(state: AppState): AppState {
    saveLocalValue(APP_STATE_STORAGE_KEY, CloudAppState, state)
    return state
  }

  /** Loads project navigation state from IndexedDB. */
  async getProjectWorkspace(projectId: ReviewProjectId): Promise<ProjectWorkspaceState | null> {
    return getRecord(PROJECT_WORKSPACES_STORE, projectId, ProjectWorkspaceState)
  }

  /** Persists one project navigation state in IndexedDB. */
  async saveProjectWorkspace(input: ProjectWorkspaceStateInput): Promise<ProjectWorkspaceState> {
    const state = ProjectWorkspaceState.make({ ...input, updatedAt: new Date().toISOString() })
    await putRecord(
      PROJECT_WORKSPACES_STORE,
      input.projectId,
      Schema.encodeUnknownSync(ProjectWorkspaceState)(state),
    )
    return state
  }

  /** Lists exact-generation viewed-file records for one hosted review. */
  async listViewedFiles(request: HostedViewedFilesRequest): Promise<readonly ViewedFileRecord[]> {
    const reviewKey = makeReviewKey(request.review)
    const records = await getAllRecords(VIEWED_FILES_STORE, ViewedFileRecord)
    return records.filter((record) => record.reviewKey === reviewKey)
  }

  /** Applies one exact patch-hash viewed-file write. */
  async setViewedFile(request: SetHostedViewedFileRequest): Promise<void> {
    const key = viewedFileKey(request.reviewKey, request.patchHash)
    if (!request.viewed) {
      await deleteRecord(VIEWED_FILES_STORE, key)
      return
    }
    const record = ViewedFileRecord.make({
      reviewKey: request.reviewKey,
      patchHash: request.patchHash,
    })
    await putRecord(VIEWED_FILES_STORE, key, Schema.encodeUnknownSync(ViewedFileRecord)(record))
  }

  private async getRepository(projectId: ReviewProjectId): Promise<Repo | null> {
    return getRecord(REPOSITORIES_STORE, projectId, Repo)
  }

  private async requireRepository(projectId: ReviewProjectId): Promise<Repo> {
    const repository = await this.getRepository(projectId)
    if (repository === null) throw new Error("The repository is not saved in this browser.")
    return repository
  }
}

const loadLocalValue = <Value, Encoded>(
  key: string,
  schema: Schema.Codec<Value, Encoded>,
  fallback: Value,
): Value => {
  const value = window.localStorage.getItem(key)
  if (value === null) return fallback
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(value)
  } catch {
    window.localStorage.removeItem(key)
    return fallback
  }
}

const saveLocalValue = <Value, Encoded>(
  key: string,
  schema: Schema.Codec<Value, Encoded>,
  value: Value,
): void => {
  window.localStorage.setItem(key, Schema.encodeSync(Schema.fromJsonString(schema))(value))
}

const viewedFileKey = (reviewKey: string, patchHash: string): string =>
  JSON.stringify([reviewKey, patchHash])

let databasePromise: Promise<IDBDatabase> | null = null

const openDatabase = (): Promise<IDBDatabase> => {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = window.indexedDB.open(CLOUD_DATABASE_NAME, CLOUD_DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      for (const store of [REPOSITORIES_STORE, PROJECT_WORKSPACES_STORE, VIEWED_FILES_STORE]) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Could not open browser storage."))
  })
  return databasePromise
}

const getRecord = async <Value, Encoded>(
  storeName: string,
  key: IDBValidKey,
  schema: Schema.Codec<Value, Encoded>,
): Promise<Value | null> => {
  const database = await openDatabase()
  return new Promise<Value | null>((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key)
    request.onsuccess = () => {
      try {
        resolve(
          request.result === undefined ? null : Schema.decodeUnknownSync(schema)(request.result),
        )
      } catch (error) {
        reject(error)
      }
    }
    request.onerror = () => reject(request.error ?? new Error("Could not read browser storage."))
  })
}

const getAllRecords = async <Value, Encoded>(
  storeName: string,
  schema: Schema.Codec<Value, Encoded>,
): Promise<readonly Value[]> => {
  const database = await openDatabase()
  return new Promise<readonly Value[]>((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll()
    request.onsuccess = () => {
      try {
        resolve(Schema.decodeUnknownSync(Schema.Array(schema))(request.result))
      } catch (error) {
        reject(error)
      }
    }
    request.onerror = () => reject(request.error ?? new Error("Could not read browser storage."))
  })
}

const putRecord = async (
  storeName: string,
  key: IDBValidKey,
  value: Schema.Json,
): Promise<void> => {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite")
    transaction.objectStore(storeName).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not save browser storage."))
  })
}

const deleteRecord = async (storeName: string, key: IDBValidKey): Promise<void> => {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite")
    transaction.objectStore(storeName).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not update browser storage."))
  })
}
