import { describe, expect, it } from "vitest"
import { resolveApplicationIdentity } from "./application-identity"

describe("application identity", () => {
  it("preserves the stable packaged identity and storage namespace", () => {
    expect(resolveApplicationIdentity({ appDataPath: "/app-data", packaged: true })).toEqual({
      appName: "DiffDash",
      appUserModelId: "dev.diffdash.app",
      storageNamespace: "diffdash",
      userDataPath: "/app-data/DiffDash",
    })
    expect(
      resolveApplicationIdentity({
        appDataPath: "C:\\Users\\me\\AppData\\Roaming",
        packaged: true,
      }),
    ).toEqual({
      appName: "DiffDash",
      appUserModelId: "dev.diffdash.app",
      storageNamespace: "diffdash",
      userDataPath: "C:\\Users\\me\\AppData\\Roaming/DiffDash",
    })
  })

  it("does not override an explicit packaged Electron user-data directory", () => {
    expect(
      resolveApplicationIdentity({
        appDataPath: "/app-data",
        explicitUserDataDirectory: true,
        packaged: true,
      }),
    ).toEqual({
      appName: "DiffDash",
      appUserModelId: "dev.diffdash.app",
      storageNamespace: "diffdash",
      userDataPath: null,
    })
  })

  it("isolates development from stable application data and instance locking", () => {
    expect(resolveApplicationIdentity({ appDataPath: "/app-data", packaged: false })).toEqual({
      appName: "DiffDash Development",
      appUserModelId: "dev.diffdash.app.development",
      storageNamespace: "diffdash-development",
      userDataPath: "/app-data/DiffDash Development",
    })
  })

  it("does not override an explicit Electron user-data directory", () => {
    expect(
      resolveApplicationIdentity({
        appDataPath: "/app-data",
        explicitUserDataDirectory: true,
        packaged: false,
      }),
    ).toEqual({
      appName: "DiffDash Development",
      appUserModelId: "dev.diffdash.app.development",
      storageNamespace: "diffdash-development",
      userDataPath: null,
    })
  })
})
