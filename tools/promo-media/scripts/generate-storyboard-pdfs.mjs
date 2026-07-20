import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { chromium } from "playwright"

const packageRoot = resolve(import.meta.dirname, "..")
const cacheDirectory = resolve(packageRoot, ".cache/storyboard")
const outputDirectory = resolve(packageRoot, "output")
const frames = [60, 195, 450, 720, 1020, 1140]
const formats = [
  {
    id: "landscape",
    composition: "PromoLandscape",
    page: { width: "16in", height: "9in" },
  },
  {
    id: "vertical",
    composition: "PromoVertical",
    page: { width: "9in", height: "16in" },
  },
]

await mkdir(cacheDirectory, { recursive: true })
await mkdir(outputDirectory, { recursive: true })

const renderedFormats = formats.map((format) => {
  const framePaths = frames.map((frame, index) => {
    const framePath = resolve(
      cacheDirectory,
      `${format.id}-${String(index + 1).padStart(2, "0")}.png`,
    )
    run("pnpm", [
      "exec",
      "remotion",
      "still",
      "src/index.ts",
      format.composition,
      framePath,
      "--public-dir=public",
      `--frame=${frame}`,
      "--log=error",
    ])
    return framePath
  })
  return { format, framePaths }
})

await Promise.all(
  renderedFormats.map(({ format, framePaths }) =>
    createPdf(
      framePaths,
      resolve(outputDirectory, `diffdash-v0.2.1-storyboard-${format.id}.pdf`),
      format.page,
    ),
  ),
)

process.stdout.write(
  "Generated landscape and vertical storyboard PDFs in tools/promo-media/output\n",
)

async function createPdf(imagePaths, outputPath, pageSize) {
  const images = await Promise.all(
    imagePaths.map(
      async (path) => `data:image/png;base64,${(await readFile(path)).toString("base64")}`,
    ),
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <!doctype html>
      <html>
        <head>
          <style>
            @page { size: ${pageSize.width} ${pageSize.height}; margin: 0; }
            * { box-sizing: border-box; }
            html, body { margin: 0; background: #06101c; }
            .page {
              width: ${pageSize.width};
              height: ${pageSize.height};
              overflow: hidden;
              break-after: page;
              background: #06101c;
            }
            .page:last-child { break-after: auto; }
            img { display: block; width: 100%; height: 100%; object-fit: cover; }
          </style>
        </head>
        <body>${images.map((source) => `<section class="page"><img src="${source}" /></section>`).join("")}</body>
      </html>
    `)
    await page.waitForFunction(() => [...document.images].every((image) => image.complete))
    await page.pdf({
      path: outputPath,
      printBackground: true,
      preferCSSPageSize: true,
      tagged: true,
    })
  } finally {
    await browser.close()
  }
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: packageRoot,
    encoding: "utf8",
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
}
