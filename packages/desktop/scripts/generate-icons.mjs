import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { deflateSync, inflateSync } from "node:zlib"

const sourceLogoPath = resolve("logo.png")
const outputDirectory = resolve("resources/icons")
const pngDirectory = join(outputDirectory, "png")
const iconsetDirectory = join(outputDirectory, "DiffDash.iconset")
const pngSizes = [16, 32, 64, 128, 256, 512, 1024]
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const sourceLogoBytes = readFileSync(sourceLogoPath)
const sourceLogo = decodePng(sourceLogoBytes)

rmSync(pngDirectory, { force: true, recursive: true })
mkdirSync(pngDirectory, { recursive: true })
rmSync(iconsetDirectory, { force: true, recursive: true })
mkdirSync(iconsetDirectory, { recursive: true })

const pngEntries = pngSizes.map((size) => {
  const png = encodePng(resizeImage(sourceLogo, size, size))
  writeFileSync(join(pngDirectory, `${size}x${size}.png`), png)
  return { size, png }
})

writeFileSync(join(outputDirectory, "icon.png"), getPngEntry(512).png)
writeFileSync(
  join(outputDirectory, "icon.ico"),
  makeIco(pngEntries.filter((entry) => entry.size <= 256)),
)
writeFileSync(
  join(outputDirectory, "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sourceLogo.width} ${sourceLogo.height}"><image width="${sourceLogo.width}" height="${sourceLogo.height}" href="${relative(outputDirectory, sourceLogoPath)}"/></svg>`,
)

writeIconsetPng("icon_16x16.png", 16)
writeIconsetPng("icon_16x16@2x.png", 32)
writeIconsetPng("icon_32x32.png", 32)
writeIconsetPng("icon_32x32@2x.png", 64)
writeIconsetPng("icon_128x128.png", 128)
writeIconsetPng("icon_128x128@2x.png", 256)
writeIconsetPng("icon_256x256.png", 256)
writeIconsetPng("icon_256x256@2x.png", 512)
writeIconsetPng("icon_512x512.png", 512)
writeIconsetPng("icon_512x512@2x.png", 1024)

if (process.platform === "darwin") {
  try {
    execFileSync("iconutil", [
      "-c",
      "icns",
      iconsetDirectory,
      "-o",
      join(outputDirectory, "icon.icns"),
    ])
  } catch {
    process.stderr.write("Could not generate icon.icns because iconutil failed.\n")
  }
}

function writeIconsetPng(filename, size) {
  writeFileSync(join(iconsetDirectory, filename), getPngEntry(size).png)
}

function getPngEntry(size) {
  const entry = pngEntries.find((candidate) => candidate.size === size)
  if (entry === undefined) throw new Error(`Missing ${size}px PNG`)
  return entry
}

function decodePng(buffer) {
  if (
    buffer.length < pngSignature.length ||
    !buffer.subarray(0, pngSignature.length).equals(pngSignature)
  ) {
    throw new Error(`${sourceLogoPath} is not a PNG file`)
  }

  let offset = pngSignature.length
  let header = null
  let palette = null
  let transparency = null
  const imageDataChunks = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString("ascii", offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const data = buffer.subarray(dataStart, dataEnd)

    if (type === "IHDR") header = readHeader(data)
    if (type === "PLTE") palette = data
    if (type === "tRNS") transparency = data
    if (type === "IDAT") imageDataChunks.push(data)
    if (type === "IEND") break

    offset = dataEnd + 4
  }

  if (header === null) throw new Error(`${sourceLogoPath} is missing a PNG header`)
  if (header.bitDepth !== 8) throw new Error(`${sourceLogoPath} must use 8-bit PNG color depth`)
  if (header.interlaceMethod !== 0)
    throw new Error(`${sourceLogoPath} must be a non-interlaced PNG`)

  const channels = getChannelCount(header.colorType)
  const stride = header.width * channels
  const inflated = inflateSync(Buffer.concat(imageDataChunks))
  const expectedLength = (stride + 1) * header.height
  if (inflated.length < expectedLength) throw new Error(`${sourceLogoPath} has incomplete PNG data`)

  const scanlines = unfilterScanlines(inflated, header.width, header.height, channels)
  return {
    width: header.width,
    height: header.height,
    pixels: toRgbaPixels(scanlines, header, palette, transparency),
  }
}

function readHeader(data) {
  if (data.length !== 13) throw new Error(`${sourceLogoPath} has an invalid PNG header`)
  return {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    bitDepth: data[8],
    colorType: data[9],
    compressionMethod: data[10],
    filterMethod: data[11],
    interlaceMethod: data[12],
  }
}

function getChannelCount(colorType) {
  if (colorType === 0) return 1
  if (colorType === 2) return 3
  if (colorType === 3) return 1
  if (colorType === 4) return 2
  if (colorType === 6) return 4
  throw new Error(`${sourceLogoPath} uses unsupported PNG color type ${colorType}`)
}

function unfilterScanlines(inflated, width, height, channels) {
  const stride = width * channels
  const output = Buffer.alloc(stride * height)
  let sourceOffset = 0
  let outputOffset = 0

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset]
    sourceOffset += 1
    const row = inflated.subarray(sourceOffset, sourceOffset + stride)
    sourceOffset += stride

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? output[outputOffset + x - channels] : 0
      const up = y > 0 ? output[outputOffset + x - stride] : 0
      const upperLeft = y > 0 && x >= channels ? output[outputOffset + x - stride - channels] : 0
      output[outputOffset + x] = (row[x] + filterByte(filter, left, up, upperLeft)) & 0xff
    }

    outputOffset += stride
  }

  return output
}

function filterByte(filter, left, up, upperLeft) {
  if (filter === 0) return 0
  if (filter === 1) return left
  if (filter === 2) return up
  if (filter === 3) return Math.floor((left + up) / 2)
  if (filter === 4) return paethPredictor(left, up, upperLeft)
  throw new Error(`${sourceLogoPath} uses unsupported PNG filter ${filter}`)
}

function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upperLeftDistance = Math.abs(estimate - upperLeft)

  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left
  if (upDistance <= upperLeftDistance) return up
  return upperLeft
}

function toRgbaPixels(scanlines, header, palette, transparency) {
  const pixels = Buffer.alloc(header.width * header.height * 4)
  let sourceOffset = 0
  let outputOffset = 0

  for (let index = 0; index < header.width * header.height; index += 1) {
    if (header.colorType === 0) {
      const gray = scanlines[sourceOffset]
      const transparentGray = transparency?.length >= 2 ? transparency.readUInt16BE(0) : null
      const alpha = transparentGray === gray ? 0 : 255
      writePixel(pixels, outputOffset, gray, gray, gray, alpha)
      sourceOffset += 1
    }

    if (header.colorType === 2) {
      const red = scanlines[sourceOffset]
      const green = scanlines[sourceOffset + 1]
      const blue = scanlines[sourceOffset + 2]
      const alpha = isTransparentRgb(red, green, blue, transparency) ? 0 : 255
      writePixel(pixels, outputOffset, red, green, blue, alpha)
      sourceOffset += 3
    }

    if (header.colorType === 3) {
      const paletteIndex = scanlines[sourceOffset]
      const paletteOffset = paletteIndex * 3
      if (palette === null || paletteOffset + 2 >= palette.length) {
        throw new Error(`${sourceLogoPath} has an invalid PNG palette`)
      }
      writePixel(
        pixels,
        outputOffset,
        palette[paletteOffset],
        palette[paletteOffset + 1],
        palette[paletteOffset + 2],
        transparency?.[paletteIndex] ?? 255,
      )
      sourceOffset += 1
    }

    if (header.colorType === 4) {
      const gray = scanlines[sourceOffset]
      const alpha = scanlines[sourceOffset + 1]
      writePixel(pixels, outputOffset, gray, gray, gray, alpha)
      sourceOffset += 2
    }

    if (header.colorType === 6) {
      writePixel(
        pixels,
        outputOffset,
        scanlines[sourceOffset],
        scanlines[sourceOffset + 1],
        scanlines[sourceOffset + 2],
        scanlines[sourceOffset + 3],
      )
      sourceOffset += 4
    }

    outputOffset += 4
  }

  return pixels
}

function isTransparentRgb(red, green, blue, transparency) {
  if (transparency === null || transparency.length < 6) return false
  return (
    red === transparency.readUInt16BE(0) &&
    green === transparency.readUInt16BE(2) &&
    blue === transparency.readUInt16BE(4)
  )
}

function writePixel(pixels, offset, red, green, blue, alpha) {
  pixels[offset] = red
  pixels[offset + 1] = green
  pixels[offset + 2] = blue
  pixels[offset + 3] = alpha
}

function resizeImage(source, width, height) {
  const pixels = Buffer.alloc(width * height * 4)
  const scale = Math.min(width / source.width, height / source.height)
  const scaledWidth = source.width * scale
  const scaledHeight = source.height * scale
  const offsetX = (width - scaledWidth) / 2
  const offsetY = (height - scaledHeight) / 2
  let outputOffset = 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centeredX = x + 0.5
      const centeredY = y + 0.5
      if (
        centeredX >= offsetX &&
        centeredX < offsetX + scaledWidth &&
        centeredY >= offsetY &&
        centeredY < offsetY + scaledHeight
      ) {
        const sourceX = (centeredX - offsetX) / scale - 0.5
        const sourceY = (centeredY - offsetY) / scale - 0.5
        const color = sampleBilinear(source, sourceX, sourceY)
        writePixel(pixels, outputOffset, color.red, color.green, color.blue, color.alpha)
      }
      outputOffset += 4
    }
  }

  return { width, height, pixels }
}

function sampleBilinear(source, x, y) {
  const clampedX = clamp(x, 0, source.width - 1)
  const clampedY = clamp(y, 0, source.height - 1)
  const left = Math.floor(clampedX)
  const top = Math.floor(clampedY)
  const right = Math.min(source.width - 1, left + 1)
  const bottom = Math.min(source.height - 1, top + 1)
  const xAmount = clampedX - left
  const yAmount = clampedY - top

  return mixSamples(
    [
      { offset: pixelOffset(source.width, left, top), weight: (1 - xAmount) * (1 - yAmount) },
      { offset: pixelOffset(source.width, right, top), weight: xAmount * (1 - yAmount) },
      { offset: pixelOffset(source.width, left, bottom), weight: (1 - xAmount) * yAmount },
      { offset: pixelOffset(source.width, right, bottom), weight: xAmount * yAmount },
    ],
    source.pixels,
  )
}

function mixSamples(samples, pixels) {
  let red = 0
  let green = 0
  let blue = 0
  let alpha = 0

  for (const sample of samples) {
    const sampleAlpha = pixels[sample.offset + 3] / 255
    const weight = sample.weight * sampleAlpha
    red += pixels[sample.offset] * weight
    green += pixels[sample.offset + 1] * weight
    blue += pixels[sample.offset + 2] * weight
    alpha += sampleAlpha * sample.weight
  }

  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 }
  return {
    red: Math.round(clamp(red / alpha, 0, 255)),
    green: Math.round(clamp(green / alpha, 0, 255)),
    blue: Math.round(clamp(blue / alpha, 0, 255)),
    alpha: Math.round(clamp(alpha * 255, 0, 255)),
  }
}

function pixelOffset(width, x, y) {
  return (y * width + x) * 4
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function encodePng(image) {
  const stride = image.width * 4
  const data = Buffer.alloc((stride + 1) * image.height)
  let sourceOffset = 0
  let outputOffset = 0

  for (let y = 0; y < image.height; y += 1) {
    data[outputOffset] = 0
    outputOffset += 1
    image.pixels.copy(data, outputOffset, sourceOffset, sourceOffset + stride)
    sourceOffset += stride
    outputOffset += stride
  }

  const chunks = [
    pngChunk(
      "IHDR",
      Buffer.concat([uint32(image.width), uint32(image.height), Buffer.from([8, 6, 0, 0, 0])]),
    ),
    pngChunk("IDAT", deflateSync(data)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]
  return Buffer.concat([pngSignature, ...chunks])
}

function makeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(entries.length * 16)
  let imageOffset = header.length + directory.length
  entries.forEach((entry, index) => {
    const offset = index * 16
    directory[offset] = entry.size >= 256 ? 0 : entry.size
    directory[offset + 1] = entry.size >= 256 ? 0 : entry.size
    directory[offset + 2] = 0
    directory[offset + 3] = 0
    directory.writeUInt16LE(1, offset + 4)
    directory.writeUInt16LE(32, offset + 6)
    directory.writeUInt32LE(entry.png.length, offset + 8)
    directory.writeUInt32LE(imageOffset, offset + 12)
    imageOffset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii")
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data]))),
  ])
}

function uint32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value >>> 0, 0)
  return buffer
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let index = 0; index < 8; index += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
