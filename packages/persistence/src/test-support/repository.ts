import { makeHostedRepositoryLocator } from "@diffdash/domain/git-provider"
import {
  hostedRepositoryInput,
  linkedRepositoryCheckout,
  localRepositoryInput,
  remoteOnlyRepositoryCheckout,
  type UpsertRepositoryInput,
} from "@diffdash/domain/repository"

/** Builds a hosted repository input for persistence integration tests. */
export const hostedTestRepositoryInput = ({
  localPath = null,
  name = "diffdash",
  namespace = "fungsi",
  providerId = "github",
  remoteUrl = `https://github.com/${namespace}/${name}`,
}: {
  readonly localPath?: string | null
  readonly name?: string
  readonly namespace?: string
  readonly providerId?: string
  readonly remoteUrl?: string
} = {}): UpsertRepositoryInput =>
  hostedRepositoryInput(
    makeHostedRepositoryLocator(providerId, namespace, name),
    localPath === null
      ? remoteOnlyRepositoryCheckout(remoteUrl)
      : linkedRepositoryCheckout(remoteUrl, localPath),
    "preserve",
  )

/** Builds a linked local repository input for persistence integration tests. */
export const localTestRepositoryInput = (
  localPath: string,
  remoteUrl = `file://${localPath}`,
): UpsertRepositoryInput =>
  localRepositoryInput(linkedRepositoryCheckout(remoteUrl, localPath), "preserve")
