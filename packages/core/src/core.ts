export { CoreConfiguration } from "./core-configuration"

/** Lifecycle exposed by an embedded DiffDash Core host. */
export interface EmbeddedCore {
  /** Acquires Core resources and completes startup recovery. */
  readonly start: () => Promise<void>

  /** Releases every resource owned by Core. */
  readonly dispose: () => Promise<void>
}
