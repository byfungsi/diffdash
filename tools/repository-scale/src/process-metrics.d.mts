export const REPOSITORY_SCALE_MEASUREMENT_POLICY: {
  readonly durationMs: number
  readonly intervalMs: number
  readonly plateauWindowMs: number
  readonly plateauThreshold: number
}

export type MachineProfile = {
  readonly platform: NodeJS.Platform
  readonly architecture: string
  readonly operatingSystemRelease: string
  readonly logicalCpuCount: number
  readonly physicalMemoryBytes: number
  readonly nodeVersion: string
}

export const captureMachineProfile: () => MachineProfile

export type ProcessRoleMeasurement = {
  readonly processCount: number
  readonly rssBytes: number
  readonly privateBytes: number | null
  readonly swapBytes: number | null
  readonly readBytes: number | null
  readonly writeBytes: number | null
}

export type ProcessRoleTotals = {
  readonly electron: ProcessRoleMeasurement
  readonly renderer: ProcessRoleMeasurement
  readonly coreWorker: ProcessRoleMeasurement
  readonly child: ProcessRoleMeasurement
}

export type ProcessTreeCapture = {
  readonly capturedAt: string
  readonly byRole: ProcessRoleTotals
  readonly counters: readonly {
    readonly pid: number
    readonly role: "electron" | "renderer" | "coreWorker" | "child"
    readonly readBytes: number | null
    readonly writeBytes: number | null
  }[]
}

export type ProcessTreeMeasurement = {
  readonly version: number
  readonly platform: string
  readonly rootPid: number
  readonly startedAt: string
  readonly completedAt: string
  readonly sampleCount: number
  readonly samples: readonly {
    readonly elapsedMs: number
    readonly capturedAt: string
    readonly byRole: ProcessRoleTotals
  }[]
  readonly intervalMs: number
  readonly durationMs: number
  readonly peaks: {
    readonly [Role in keyof ProcessRoleTotals]: {
      readonly rssBytes: number | null
      readonly privateBytes: number | null
      readonly swapBytes: number | null
      readonly readBytes: number | null
      readonly writeBytes: number | null
    }
  }
  readonly final: {
    readonly [Role in keyof ProcessRoleTotals]: {
      readonly processCount: number
      readonly rssBytes: number
      readonly privateBytes: number | null
      readonly swapBytes: number | null
    }
  }
  readonly totalPeakRssBytes: number
  readonly totalFinalRssBytes: number
  readonly steadyWindow: {
    readonly windowMs: number
    readonly threshold: number
    readonly variation: number
    readonly reached: boolean
  }
}

export const captureProcessTree: (rootPid: number) => Promise<ProcessTreeCapture>
export const measureManagedStorage: (paths: {
  readonly databasePath: string
  readonly snapshotBlocksRoot: string
  readonly snapshotSpoolsRoot: string
  readonly worktreePoolRoot: string
  readonly remoteWorktreePoolRoot: string
}) => Promise<{
  readonly databaseBytes: number
  readonly managedBytes: number
  readonly managedRoots: {
    readonly snapshotBlockBytes: number
    readonly snapshotSpoolBytes: number
    readonly worktreePoolBytes: number
    readonly remoteWorktreePoolBytes: number
  }
  readonly filesystemFreeBytes: number
  readonly filesystemTotalBytes: number
}>
export const measureProcessTree: (options: {
  readonly rootPid: number
  readonly durationMs: number
  readonly intervalMs: number
  readonly plateauWindowMs: number
  readonly plateauThreshold: number
}) => Promise<ProcessTreeMeasurement>
