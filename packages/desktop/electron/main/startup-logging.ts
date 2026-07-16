const startupStartedAt = Date.now() - process.uptime() * 1_000

/** Logs a startup milestone relative to process creation. */
export const logStartupStage = (stage: string) => {
  console.info(`[startup] ${stage} +${Math.round(Date.now() - startupStartedAt)}ms`)
}
