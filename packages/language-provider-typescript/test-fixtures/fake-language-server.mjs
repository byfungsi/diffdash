import { appendFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import { Effect, HashSet, Option, Ref } from "effect"

if (process.argv.includes("--version")) {
  process.stdout.write("fake-language-server 1.0.0\n")
  process.exit(0)
}

const buffer = Ref.makeUnsafe(Buffer.alloc(0))
const markerPath = Ref.makeUnsafe(Option.none())
const opened = Ref.makeUnsafe(HashSet.empty())

const currentMarkerPath = () => Option.getOrElse(Ref.getUnsafe(markerPath), () => process.exit(14))

const send = (message) => {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

const respond = (id, result) => send({ jsonrpc: "2.0", id, result })

const handle = (message) => {
  if (message.method === "initialize") {
    const valid =
      message.params?.capabilities?.general?.positionEncodings?.[0] === "utf-16" &&
      message.params?.rootUri?.startsWith("file:") &&
      message.params?.initializationOptions?.tsserver?.path?.length > 0
    if (!valid) process.exit(12)
    const initializedMarkerPath = message.params.initializationOptions.tsserver.path
    Effect.runSync(Ref.set(markerPath, Option.some(initializedMarkerPath)))
    appendFileSync(`${initializedMarkerPath}.pid`, `${process.pid}\n`)
    if (initializedMarkerPath.includes("stubborn")) process.on("SIGTERM", () => {})
    respond(message.id, { capabilities: { positionEncoding: "utf-16" } })
    return
  }
  if (message.method === "textDocument/didOpen") {
    Effect.runSync(Ref.update(opened, HashSet.add(message.params.textDocument.uri)))
    return
  }
  if (message.method === "$/cancelRequest") {
    appendFileSync(`${currentMarkerPath()}.cancelled`, `${message.params.id}\n`)
    return
  }
  if (message.method === "shutdown") {
    const path = currentMarkerPath()
    if (path.includes("stubborn")) return
    appendFileSync(`${path}.shutdown`, "shutdown\n")
    respond(message.id, null)
    return
  }
  if (message.method === "exit") {
    const path = currentMarkerPath()
    if (path.includes("stubborn")) return
    appendFileSync(`${path}.exited`, "exit\n")
    process.exit(0)
  }
  if (message.id === undefined) return

  const documentUri = Option.fromNullishOr(message.params?.textDocument?.uri)
  if (Option.exists(documentUri, (uri) => !HashSet.has(Ref.getUnsafe(opened), uri))) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "document was not opened" },
    })
    return
  }

  if (message.method === "textDocument/definition") {
    if (message.params.position.character === 99) return
    const sourceUri = Option.getOrElse(documentUri, () => process.exit(16))
    let targetUri = pathToFileURL(join(dirname(fileURLToPath(sourceUri)), "target.ts")).href
    if (message.params.position.character === 97) targetUri = "not a valid URI"
    if (message.params.position.character === 98) {
      targetUri = pathToFileURL("/etc/passwd").href
    }
    respond(message.id, [
      {
        originSelectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 6 },
        },
        targetUri,
        targetRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 19 },
        },
        targetSelectionRange: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 19 },
        },
      },
    ])
    return
  }
  if (message.method === "textDocument/references") {
    const sourceUri = Option.getOrElse(documentUri, () => process.exit(17))
    respond(message.id, [
      {
        uri: sourceUri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 6 },
        },
      },
    ])
    return
  }
  if (message.method === "textDocument/documentSymbol") {
    respond(message.id, [
      {
        name: "source",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 19 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
      },
    ])
    return
  }
  if (message.method === "workspace/symbol") {
    const sourceUri = Option.getOrElse(
      Option.orElse(documentUri, () => Option.fromIterable(Ref.getUnsafe(opened))),
      () => process.exit(15),
    )
    respond(message.id, [
      {
        name: "target",
        kind: 12,
        location: {
          uri: pathToFileURL(join(dirname(fileURLToPath(sourceUri)), "target.ts")).href,
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
        },
      },
    ])
  }
}

const drain = () => {
  while (Ref.getUnsafe(buffer).length > 0) {
    const currentBuffer = Ref.getUnsafe(buffer)
    const separator = currentBuffer.indexOf("\r\n\r\n")
    if (separator < 0) return
    const header = currentBuffer.subarray(0, separator).toString("ascii")
    const match = Option.getOrElse(
      Option.fromNullishOr(/Content-Length: ([0-9]+)/i.exec(header)),
      () => process.exit(13),
    )
    const length = Number(Option.getOrElse(Option.fromNullishOr(match[1]), () => process.exit(18)))
    const bodyStart = separator + 4
    if (currentBuffer.length < bodyStart + length) return
    const body = currentBuffer.subarray(bodyStart, bodyStart + length).toString("utf8")
    Effect.runSync(Ref.set(buffer, currentBuffer.subarray(bodyStart + length)))
    handle(JSON.parse(body))
  }
}

process.stdin.on("data", (chunk) => {
  Effect.runSync(Ref.update(buffer, (currentBuffer) => Buffer.concat([currentBuffer, chunk])))
  drain()
})
