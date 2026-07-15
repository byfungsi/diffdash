const fallbackUrl = "https://github.com/byfungsi/diffdash/releases/latest"
const releasePrefix = "releases/"

const platformMatchers = {
  macos: {
    label: "macOS",
    extensions: [".dmg"],
    preferredTokens: ["universal", "arm64", "mac", "darwin", "x64"],
  },
  linux: {
    label: "Linux DEB",
    extensions: [".deb"],
    preferredTokens: ["x64", "amd64", "linux"],
  },
  appimage: {
    label: "Linux AppImage",
    extensions: [".appimage"],
    preferredTokens: ["x86_64", "x64", "amd64", "linux"],
  },
}

const architectureAliases = {
  amd64: ["amd64", "x64", "x86_64"],
  x64: ["x64", "amd64", "x86_64"],
  x86_64: ["x86_64", "x64", "amd64"],
}

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
    if (updateRequest) {
      return handleUpdateRequest(request, env, updateRequest)
    }
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
      const asset = await findStableAsset(env, platform, url.searchParams.get("arch"))

      if (!asset) {
        return redirect(fallbackUrl)
      }

      return redirect(asset.url)
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
    const tag = await getStableTag(env.RELEASES_BUCKET)
    if (!tag) return new Response("No stable release", { status: 404 })
    const requestedFile = updateRequest.file
    const metadataName = updateRequest.platform === "macos" ? "latest-mac.yml" : "latest-linux.yml"
    if (requestedFile === metadataName) {
      const storedName =
        updateRequest.platform === "macos"
          ? `latest-mac-${updateRequest.arch}.yml`
          : "latest-linux.yml"
      const object = await env.RELEASES_BUCKET.get(`${releasePrefix}${tag}/${storedName}`)
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

    if (!isSafeUpdateAssetName(requestedFile, updateRequest)) {
      return new Response("Update artifact not found", { status: 404 })
    }
    const objects = await listReleaseObjects(env.RELEASES_BUCKET, `${releasePrefix}${tag}/`)
    const key = `${releasePrefix}${tag}/${requestedFile}`
    if (!objects.some((object) => object.key === key)) {
      return new Response("Update artifact not found", { status: 404 })
    }
    const baseUrl = String(env.PUBLIC_RELEASE_BASE_URL ?? "").replace(/\/+$/, "")
    return redirect(`${baseUrl}/${releasePrefix}${tag}/${encodeURIComponent(requestedFile)}`)
  } catch {
    return new Response("Update feed unavailable", { status: 503 })
  }
}

function isSafeUpdateAssetName(file, updateRequest) {
  if (!file || file.includes("/") || file.includes("..")) return false
  const normalized = file.toLowerCase()
  if (updateRequest.platform === "macos") {
    return (
      normalized.includes(`-mac-${updateRequest.arch}.zip`) &&
      (normalized.endsWith(".zip") || normalized.endsWith(".zip.blockmap"))
    )
  }
  return (
    (normalized.includes("-linux-x64") || normalized.includes("-linux-x86_64")) &&
    (normalized.endsWith(".appimage") || normalized.endsWith(".appimage.blockmap"))
  )
}

function getPlatform(pathname) {
  const normalizedPath = pathname.replace(/^\/+|\/+$/g, "").toLowerCase()
  const segment = normalizedPath.split("/").at(-1)

  if (normalizedPath === "linux/appimage") {
    return "appimage"
  }

  if (segment === "mac" || segment === "macos" || segment === "darwin") {
    return "macos"
  }

  if (segment === "linux" || segment === "deb") {
    return "linux"
  }

  return undefined
}

async function findStableAsset(env, platform, requestedArch) {
  if (!env.RELEASES_BUCKET) {
    throw new Error("Missing RELEASES_BUCKET binding")
  }

  const tag = await getStableTag(env.RELEASES_BUCKET)
  if (!tag) return undefined
  const objects = await listReleaseObjects(env.RELEASES_BUCKET, `${releasePrefix}${tag}/`)
  const assets = []

  for (const object of objects) {
    const parsed = parseReleaseKey(object.key)

    if (parsed?.tag === tag && matchesPlatform(parsed.name, platform)) assets.push(parsed)
  }
  const architectureMatches = requestedArch
    ? assets.filter((asset) => matchesArchitecture(asset.name.toLowerCase(), requestedArch))
    : assets
  const selected = architectureMatches.toSorted(
    (left, right) =>
      scoreAsset(right.name, platform, requestedArch) -
      scoreAsset(left.name, platform, requestedArch),
  )[0]

  if (!selected) {
    return undefined
  }

  const baseUrl = String(env.PUBLIC_RELEASE_BASE_URL ?? "").replace(/\/+$/, "")
  const url = baseUrl
    ? `${baseUrl}/${releasePrefix}${tag}/${encodeURIComponent(selected.name)}`
    : fallbackUrl

  return { tag, name: selected.name, url }
}

async function getStableTag(bucket) {
  const object = await bucket.get("stable.json")
  if (!object) return undefined
  const metadata = JSON.parse(await object.text())
  return typeof metadata.tag === "string" && /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(metadata.tag)
    ? metadata.tag
    : undefined
}

async function listReleaseObjects(bucket, prefix, cursor, objects = []) {
  const result = await bucket.list({ cursor, prefix })
  const nextObjects = [...objects, ...result.objects]

  if (!result.truncated) {
    return nextObjects
  }

  return listReleaseObjects(bucket, prefix, result.cursor, nextObjects)
}

function parseReleaseKey(key) {
  const match = /^releases\/([^/]+)\/([^/]+)$/.exec(key)

  if (!match) {
    return undefined
  }

  return { tag: match[1], name: match[2] }
}

function matchesPlatform(name, platform) {
  const normalizedName = name.toLowerCase()
  return platformMatchers[platform].extensions.some((extension) =>
    normalizedName.endsWith(extension),
  )
}

function scoreAsset(name, platform, requestedArch) {
  const normalizedName = name.toLowerCase()
  const matcher = platformMatchers[platform]
  let score = 0

  if (matchesArchitecture(normalizedName, requestedArch)) {
    score += 100
  }

  matcher.preferredTokens.forEach((token, index) => {
    if (normalizedName.includes(token)) {
      score += matcher.preferredTokens.length - index
    }
  })

  return score
}

function matchesArchitecture(name, requestedArch) {
  const normalizedArch = requestedArch?.trim().toLowerCase()

  if (!normalizedArch) {
    return false
  }

  const aliases = architectureAliases[normalizedArch] ?? [normalizedArch]
  return aliases.some((alias) => name.includes(alias))
}

function redirect(url) {
  return new Response(null, {
    status: 302,
    headers: {
      ...noStoreHeaders,
      Location: url,
    },
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
