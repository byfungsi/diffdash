import { runDemoCli } from "./orchestration"

await runDemoCli(process.argv.slice(2)).catch((cause: unknown) => {
  const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
