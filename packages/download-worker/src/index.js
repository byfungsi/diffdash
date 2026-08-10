import { ReleaseArtifactMatrix, ReleaseCatalog } from "./release-catalog.js"

const fallbackUrl = "https://github.com/byfungsi/diffdash/releases/latest"
const releasePrefix = "releases/"
const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Expires: "0",
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { ...noStoreHeaders, Allow: "GET, HEAD" },
      })
    }

    const url = new URL(request.url)
    const updateRequest = getUpdateRequest(url.pathname)
    if (updateRequest) return handleUpdateRequest(request, env, updateRequest)
    const platform = getPlatform(url.pathname)
    if (!platform) {
      return json(
        {
          endpoints: {
            macos: "/macos",
            linux: "/linux",
            linuxAppImage: "/linux/appimage",
          },
        },
        200,
        request.method === "HEAD",
      )
    }

    try {
      const matrix = await getStableReleaseMatrix(env)
      const architecture = normalizeArchitecture(platform, url.searchParams.get("arch"))
      const asset = ReleaseArtifactMatrix.selectDownload(matrix, platform, architecture)
      return redirect(asset?.url ?? fallbackUrl)
    } catch {
      return redirect(fallbackUrl)
    }
  },
}

function getUpdateRequest(pathname) {
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/")
  if (segments[0] !== "updates" || segments[1] !== "stable") return undefined
  const platform = segments[2]
  const arch = segments[3]
  const file = segments.slice(4).join("/")
  if (platform === "macos" && (arch === "arm64" || arch === "x64")) {
    return { platform, arch, file }
  }
  if (platform === "linux" && arch === "x64") return { platform, arch, file }
  return undefined
}

async function handleUpdateRequest(request, env, updateRequest) {
  if (!env.RELEASES_BUCKET) return new Response("Update storage unavailable", { status: 503 })

  try {
    const matrix = await getStableReleaseMatrix(env)
    const update = ReleaseArtifactMatrix.selectUpdate(
      matrix,
      updateRequest.platform,
      updateRequest.arch,
    )
    if (update === undefined) return new Response("Update artifact not found", { status: 404 })
    const requestedFile = updateRequest.file
    const publicMetadataName =
      updateRequest.platform === "macos" ? "latest-mac.yml" : "latest-linux.yml"
    if (requestedFile === publicMetadataName) {
      const object = await env.RELEASES_BUCKET.get(
        `${releasePrefix}${matrix.tag}/${update.metadata.name}`,
      )
      if (!object) return new Response("Update metadata not found", { status: 404 })
      const body = request.method === "HEAD" ? null : await object.text()
      return new Response(body, {
        status: 200,
        headers: {
          ...noStoreHeaders,
          "Content-Type": "application/yaml; charset=utf-8",
        },
      })
    }

    const downloadable = [update.artifact, update.blockmap].filter(Boolean)
    const selected = downloadable.find(({ name }) => name === requestedFile)
    return selected === undefined
      ? new Response("Update artifact not found", { status: 404 })
      : redirect(selected.url)
  } catch {
    return new Response("Update feed unavailable", { status: 503 })
  }
}

function getPlatform(pathname) {
  const normalizedPath = pathname.replace(/^\/+|\/+$/g, "").toLowerCase()
  const segment = normalizedPath.split("/").at(-1)
  if (normalizedPath === "linux/appimage") return "appimage"
  if (segment === "mac" || segment === "macos" || segment === "darwin") return "macos"
  if (segment === "linux" || segment === "deb") return "linux"
  return undefined
}

async function getStableReleaseMatrix(env) {
  if (!env.RELEASES_BUCKET) throw new Error("Missing RELEASES_BUCKET binding")
  const stableObject = await env.RELEASES_BUCKET.get("stable.json")
  if (!stableObject) throw new Error("No stable release")
  const stable = ReleaseCatalog.decodeStableManifest(JSON.parse(await stableObject.text()))
  const latestObject = await env.RELEASES_BUCKET.get(`${releasePrefix}${stable.tag}/latest.json`)
  if (!latestObject) throw new Error("Stable release manifest is unavailable")
  const publicOrigin = ReleaseCatalog.normalizePublicOrigin(env.PUBLIC_RELEASE_BASE_URL)
  const latest = ReleaseCatalog.decodeVersionedLatestManifest(
    JSON.parse(await latestObject.text()),
    {
      expectedTag: stable.tag,
      publicOrigin,
    },
  )
  return ReleaseArtifactMatrix.create(latest)
}

function normalizeArchitecture(platform, value) {
  const architecture = value?.trim().toLowerCase()
  if (platform === "macos") {
    if (architecture === "amd64" || architecture === "x86_64") return "x64"
    return architecture === undefined || architecture === "" ? "arm64" : architecture
  }
  if (architecture === "amd64" || architecture === "x86_64") return "x64"
  return architecture === undefined || architecture === "" ? "x64" : architecture
}

function redirect(url) {
  return new Response(null, {
    status: 302,
    headers: { ...noStoreHeaders, Location: url },
  })
}

function json(value, status, head = false) {
  return new Response(head ? null : JSON.stringify(value, null, 2), {
    status,
    headers: {
      ...noStoreHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  })
}
