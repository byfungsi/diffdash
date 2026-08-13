/* eslint-disable no-await-in-loop -- Story directories are scanned in display order. */
import { createReadStream } from "node:fs"
import { lstat, readdir, realpath } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, relative } from "node:path"

import { demoOutputRoot } from "./environment"
import { escapeHtml } from "./html"
import { assertDemoSlug, resolveContainedPath } from "./paths"

const mediaTypes = new Map([
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
])

interface DashboardItem {
  readonly source: string
  readonly title: string
  readonly kind: "full" | "clip"
}

/** Result of parsing one RFC 7233 single-byte-range request. */
export type ByteRangeResult =
  | { readonly kind: "none" }
  | { readonly kind: "range"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" }

/** Parses one byte range, including open-ended and suffix forms. */
export const parseByteRange = (header: string | undefined, size: number): ByteRangeResult => {
  if (header === undefined) return { kind: "none" }
  if (!Number.isSafeInteger(size) || size <= 0) return { kind: "unsatisfiable" }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header)
  if (match === null) return { kind: "unsatisfiable" }
  const startText = match[1] ?? ""
  const endText = match[2] ?? ""
  if (startText.length === 0 && endText.length === 0) return { kind: "unsatisfiable" }
  if (startText.length === 0) {
    const suffixLength = Number(endText)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: "unsatisfiable" }
    }
    return { kind: "range", start: Math.max(0, size - suffixLength), end: size - 1 }
  }
  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
    return { kind: "unsatisfiable" }
  }
  if (endText.length === 0) return { kind: "range", start, end: size - 1 }
  const requestedEnd = Number(endText)
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    return { kind: "unsatisfiable" }
  }
  return { kind: "range", start, end: Math.min(requestedEnd, size - 1) }
}

/** Decodes one media URL and rejects malformed, absolute, traversal, or unsupported paths. */
export const decodeMediaPath = (requestUrl: string) => {
  let pathname: string
  try {
    pathname = new URL(requestUrl, "http://127.0.0.1").pathname
  } catch {
    throw new Error("Malformed dashboard URL")
  }
  const match = /^\/media\/([^/]+)\/([^/]+)$/u.exec(pathname)
  if (match === null || match[1] === undefined || match[2] === undefined) return null
  let story: string
  let file: string
  try {
    story = decodeURIComponent(match[1])
    file = decodeURIComponent(match[2])
  } catch {
    throw new Error("Malformed percent encoding in dashboard media URL")
  }
  assertDemoSlug(story, "dashboard story ID")
  const extension = extname(file).toLowerCase()
  const contentType = mediaTypes.get(extension)
  if (contentType === undefined) throw new Error("Unsupported dashboard media extension")
  const stem = file.slice(0, -extension.length)
  assertDemoSlug(stem, "dashboard media filename")
  return { story, file, contentType }
}

/** Resolves dashboard media only when it is a contained regular file. */
export const resolveDashboardMedia = async (outputRoot: string, requestUrl: string) => {
  const decoded = decodeMediaPath(requestUrl)
  if (decoded === null) return null
  const path = resolveContainedPath(outputRoot, decoded.story, decoded.file)
  const fileStat = await lstat(path).catch(() => null)
  if (fileStat === null || !fileStat.isFile()) return null
  const [rootRealPath, fileRealPath] = await Promise.all([realpath(outputRoot), realpath(path)])
  const realRelativePath = relative(rootRealPath, fileRealPath)
  if (resolveContainedPath(rootRealPath, realRelativePath) !== fileRealPath) {
    throw new Error("Dashboard media resolves outside the output root")
  }
  return { ...decoded, path, size: fileStat.size }
}

/** Creates a request handler without opening a listening dashboard server. */
export const createDashboardRequestHandler =
  (outputRoot: string, html: string) =>
  async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end()
      return
    }
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(request.method === "HEAD" ? undefined : html)
      return
    }
    let media: Awaited<ReturnType<typeof resolveDashboardMedia>>
    try {
      media = await resolveDashboardMedia(outputRoot, request.url ?? "")
    } catch {
      response.writeHead(400).end()
      return
    }
    if (media === null) {
      response.writeHead(404).end()
      return
    }
    const range = parseByteRange(request.headers.range, media.size)
    if (range.kind === "unsatisfiable") {
      response
        .writeHead(416, {
          "accept-ranges": "bytes",
          "content-range": `bytes */${media.size}`,
        })
        .end()
      return
    }
    if (range.kind === "none") {
      response.writeHead(200, {
        "accept-ranges": "bytes",
        "content-type": media.contentType,
        "content-length": media.size,
      })
      if (request.method === "HEAD") response.end()
      else createReadStream(media.path).pipe(response)
      return
    }
    response.writeHead(206, {
      "accept-ranges": "bytes",
      "content-range": `bytes ${range.start}-${range.end}/${media.size}`,
      "content-length": range.end - range.start + 1,
      "content-type": media.contentType,
    })
    if (request.method === "HEAD") response.end()
    else createReadStream(media.path, { start: range.start, end: range.end }).pipe(response)
  }

/** Starts the local dashboard after safely discovering generated media. */
export const startDashboard = async () => {
  const port = Number(process.env.DEMO_DASHBOARD_PORT ?? 4321)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DEMO_DASHBOARD_PORT must be an integer from 1 to 65535")
  }
  const items = await discoverDashboardItems(demoOutputRoot)
  const html = dashboardHtml(items)
  const handle = createDashboardRequestHandler(demoOutputRoot, html)
  createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  }).listen(port, "127.0.0.1", () => {
    process.stdout.write(`[demo] dashboard http://127.0.0.1:${port}\n`)
  })
}

const discoverDashboardItems = async (outputRoot: string): Promise<readonly DashboardItem[]> => {
  const stories = await readdir(outputRoot, { withFileTypes: true }).catch(() => [])
  const items: DashboardItem[] = []
  for (const storyEntry of stories.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!storyEntry.isDirectory()) continue
    try {
      assertDemoSlug(storyEntry.name, "dashboard story ID")
    } catch {
      continue
    }
    const storyDirectory = resolveContainedPath(outputRoot, storyEntry.name)
    const files = await readdir(storyDirectory, { withFileTypes: true })
    const regularFiles = files.filter((file) => file.isFile()).map((file) => file.name)
    const combined = regularFiles.find((file) => file === `${storyEntry.name}-demo.mp4`)
    if (combined !== undefined) {
      items.push({
        source: `/media/${encodeURIComponent(storyEntry.name)}/${encodeURIComponent(combined)}`,
        title: `${storyEntry.name} · Full demo`,
        kind: "full",
      })
    }
    for (const clip of regularFiles.filter((file) => file.endsWith(".webm")).toSorted()) {
      try {
        decodeMediaPath(`/media/${encodeURIComponent(storyEntry.name)}/${encodeURIComponent(clip)}`)
      } catch {
        continue
      }
      items.push({
        source: `/media/${encodeURIComponent(storyEntry.name)}/${encodeURIComponent(clip)}`,
        title: `${storyEntry.name} · ${clip}`,
        kind: "clip",
      })
    }
  }
  return items
}

const dashboardHtml = (
  items: readonly DashboardItem[],
) => `<!doctype html><html><head><meta charset="utf-8"><title>DiffDash Demo Videos</title><style>
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:flex;background:#07111f;color:#e8edf5;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}aside{width:320px;overflow:auto;border-right:1px solid #1d2b3e;background:#0a1525;padding:20px 14px}.brand{padding:4px 10px 16px;font-size:18px;font-weight:800}.item{display:flex;width:100%;gap:10px;border:0;border-radius:9px;background:none;padding:10px;color:#bcc8d8;text-align:left;cursor:pointer}.item:hover,.item.active{background:#14243a;color:#fff}.icon{width:18px;color:#69e0b1}main{display:flex;min-width:0;flex:1;flex-direction:column}.top{padding:22px 30px 12px}.top h1{margin:0;font-size:20px}.stage{display:flex;min-height:0;flex:1;align-items:center;justify-content:center;padding:10px 30px 30px}video{max-width:100%;max-height:100%;border-radius:12px;background:#000;box-shadow:0 22px 70px rgba(0,0,0,.55)}
</style></head><body><aside><div class="brand">DiffDash Demo Videos</div>${items
  .map(
    (item) =>
      `<button class="item" data-source="${escapeHtml(item.source)}" data-title="${escapeHtml(item.title)}"><span class="icon">${item.kind === "full" ? "●" : "▶"}</span><span>${escapeHtml(item.title)}</span></button>`,
  )
  .join(
    "",
  )}</aside><main><header class="top"><h1 id="title">Select a recording</h1></header><section class="stage"><video id="player" controls preload="metadata"></video></section></main><script>
const items=[...document.querySelectorAll('.item')],player=document.querySelector('#player'),title=document.querySelector('#title');function select(item){items.forEach(current=>current.classList.toggle('active',current===item));player.src=item.dataset.source;title.textContent=item.dataset.title}items.forEach(item=>item.addEventListener('click',()=>select(item)));if(items[0])select(items[0]);
</script></body></html>`
