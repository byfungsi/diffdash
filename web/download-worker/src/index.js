const fallbackUrl = "https://github.com/byfungsi/diffdash/releases/latest"
const releasePrefix = "releases/"

const platformMatchers = {
  macos: {
    label: "macOS",
    extensions: [".dmg"],
    preferredTokens: ["universal", "arm64", "mac", "darwin", "x64"],
  },
  linux: {
    label: "Linux",
    extensions: [".deb"],
    preferredTokens: ["x64", "amd64", "linux"],
  },
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
    const platform = getPlatform(url.pathname)

    if (!platform) {
      return json(
        {
          endpoints: {
            macos: "/macos",
            linux: "/linux",
          },
        },
        200,
      )
    }

    try {
      const asset = await findLatestAsset(env, platform, url.searchParams.get("arch"))

      if (!asset) {
        return redirect(fallbackUrl)
      }

      return redirect(asset.url)
    } catch {
      return redirect(fallbackUrl)
    }
  },
}

function getPlatform(pathname) {
  const segment = pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .at(-1)
    ?.toLowerCase()

  if (segment === "mac" || segment === "macos" || segment === "darwin") {
    return "macos"
  }

  if (segment === "linux" || segment === "deb") {
    return "linux"
  }

  return undefined
}

async function findLatestAsset(env, platform, requestedArch) {
  if (!env.RELEASES_BUCKET) {
    throw new Error("Missing RELEASES_BUCKET binding")
  }

  const objects = await listReleaseObjects(env.RELEASES_BUCKET)
  const releases = new Map()

  for (const object of objects) {
    const parsed = parseReleaseKey(object.key)

    if (!parsed || !matchesPlatform(parsed.name, platform)) {
      continue
    }

    const assets = releases.get(parsed.tag) ?? []
    assets.push(parsed)
    releases.set(parsed.tag, assets)
  }

  const latest = [...releases.entries()].toSorted(([left], [right]) => compareTags(right, left))[0]

  if (!latest) {
    return undefined
  }

  const [tag, assets] = latest
  const selected = assets.toSorted(
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

async function listReleaseObjects(bucket, cursor, objects = []) {
  const result = await bucket.list({ cursor, prefix: releasePrefix })
  const nextObjects = [...objects, ...result.objects]

  if (!result.truncated) {
    return nextObjects
  }

  return listReleaseObjects(bucket, result.cursor, nextObjects)
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

  if (requestedArch && normalizedName.includes(requestedArch.toLowerCase())) {
    score += 100
  }

  matcher.preferredTokens.forEach((token, index) => {
    if (normalizedName.includes(token)) {
      score += matcher.preferredTokens.length - index
    }
  })

  return score
}

function compareTags(left, right) {
  const leftVersion = parseSemver(left)
  const rightVersion = parseSemver(right)

  if (!leftVersion || !rightVersion) {
    return left.localeCompare(right)
  }

  return (
    leftVersion.major - rightVersion.major ||
    leftVersion.minor - rightVersion.minor ||
    leftVersion.patch - rightVersion.patch
  )
}

function parseSemver(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tag)

  if (!match) {
    return undefined
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
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

function json(value, status) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      ...noStoreHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  })
}
