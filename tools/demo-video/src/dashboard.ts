/* eslint-disable no-await-in-loop -- Story directories are scanned in display order. */
import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, extname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outputRoot = resolve(packageRoot, "output")
const port = Number(process.env.DEMO_DASHBOARD_PORT ?? 4321)

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/gu, (character) => {
    const entities: Readonly<Record<string, string>> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }
    return entities[character] ?? character
  })

const stories = await readdir(outputRoot).catch(() => [])
const items: { readonly source: string; readonly title: string; readonly kind: "full" | "clip" }[] =
  []
for (const story of stories.toSorted()) {
  const files = await readdir(resolve(outputRoot, story))
  const combined = files.find((file) => file === `${story}-demo.mp4`)
  if (combined !== undefined) {
    items.push({
      source: `/media/${story}/${combined}`,
      title: `${story} · Full demo`,
      kind: "full",
    })
  }
  for (const clip of files.filter((file) => file.endsWith(".webm")).toSorted()) {
    items.push({ source: `/media/${story}/${clip}`, title: `${story} · ${clip}`, kind: "clip" })
  }
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>DiffDash Demo Videos</title><style>
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

createServer(async (request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(html)
    return
  }
  const match = request.url?.match(/^\/media\/([^/]+)\/([^/?]+)$/u)
  if (match === null || match === undefined) {
    response.writeHead(404).end()
    return
  }
  const encodedStory = match[1]
  const encodedFile = match[2]
  if (encodedStory === undefined || encodedFile === undefined) {
    response.writeHead(400).end()
    return
  }
  const story = decodeURIComponent(encodedStory)
  const file = decodeURIComponent(encodedFile)
  if (story.includes("..") || file.includes("..")) {
    response.writeHead(400).end()
    return
  }
  const path = resolve(outputRoot, story, file)
  const fileStat = await stat(path).catch(() => null)
  if (fileStat === null) {
    response.writeHead(404).end()
    return
  }
  const contentType = extname(file) === ".mp4" ? "video/mp4" : "video/webm"
  const range = request.headers.range
  if (range === undefined) {
    response.writeHead(200, { "content-type": contentType, "content-length": fileStat.size })
    createReadStream(path).pipe(response)
    return
  }
  const parsed = range.match(/bytes=(\d+)-(\d*)/u)
  const start = Number(parsed?.[1] ?? 0)
  const end =
    parsed?.[2] === "" || parsed?.[2] === undefined ? fileStat.size - 1 : Number(parsed[2])
  response.writeHead(206, {
    "accept-ranges": "bytes",
    "content-range": `bytes ${start}-${end}/${fileStat.size}`,
    "content-length": end - start + 1,
    "content-type": contentType,
  })
  createReadStream(path, { start, end }).pipe(response)
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`[demo] dashboard http://127.0.0.1:${port}\n`)
})
