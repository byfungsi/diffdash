import { cancelRender, continueRender, delayRender, staticFile } from "remotion"

const fontLoadHandle = delayRender("Load campaign font")
const inter = new FontFace(
  "Inter",
  `url('${staticFile("fonts/Inter-Latin.woff2")}') format('woff2')`,
  { style: "normal", weight: "100 900" },
)

inter
  .load()
  .then((font) => {
    document.fonts.add(font)
    continueRender(fontLoadHandle)
    return font
  })
  .catch((error: unknown) => cancelRender(error))
