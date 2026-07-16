import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const envFile = process.env.DIFFDASH_ENV_FILE ?? ".env"
const envPath = path.resolve(envFile)

if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf8")

  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (parsed === null) continue

    const [name, value] = parsed
    process.env[name] ??= value
  }
}

function parseEnvLine(line) {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null

  const withoutExport = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trim()
    : trimmed
  const equalsIndex = withoutExport.indexOf("=")
  if (equalsIndex <= 0) return null

  const name = withoutExport.slice(0, equalsIndex).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null

  const rawValue = withoutExport.slice(equalsIndex + 1).trim()
  return [name, parseValue(rawValue)]
}

function parseValue(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }

  const commentIndex = value.search(/\s+#/)
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim()
}
