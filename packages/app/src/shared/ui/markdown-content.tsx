import { WebUrl } from "@diffdash/domain/web-url"
import { Schema } from "effect"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ComponentProps } from "react"
import { useState } from "react"

import { runRendererPromise, useDesktopRuntime } from "@/platform/renderer-runtime"
import { cn } from "@/shared/utils"

/** Renders sanitized GitHub-flavored Markdown and routes web links through the desktop shell. */
export function MarkdownContent({
  children,
  className,
}: {
  readonly children: string
  readonly className?: string
}) {
  return (
    <div
      className={cn(
        "space-y-3 break-words text-sm leading-6",
        "[&_a]:text-link [&_a]:underline [&_a]:underline-offset-2",
        "[&_blockquote]:text-muted-foreground [&_blockquote]:border-l-2 [&_blockquote]:pl-4",
        "[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
        "[&_del]:text-muted-foreground",
        "[&_details]:rounded-lg [&_details]:border [&_details]:px-3 [&_details]:py-2",
        "[&_h1]:text-xl [&_h1]:font-semibold [&_h1]:tracking-tight",
        "[&_h2]:border-b [&_h2]:pb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight",
        "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:tracking-tight",
        "[&_hr]:border-border",
        "[&_img]:max-h-96 [&_img]:max-w-full [&_img]:rounded-lg [&_img]:border",
        "[&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:accent-primary",
        "[&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6",
        "[&_pre]:bg-muted [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:p-3",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-xs",
        "[&_summary]:cursor-pointer [&_summary]:font-medium",
        "[&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_table]:text-xs",
        "[&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:bg-muted [&_th]:border [&_th]:px-3 [&_th]:py-2 [&_th]:font-semibold",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={markdownComponents}
      >
        {children}
      </Markdown>
    </div>
  )
}

const MarkdownExternalLink = ({ children, href }: ComponentProps<"a">) => {
  const desktop = useDesktopRuntime()
  if (href === undefined || !Schema.is(WebUrl)(href)) return <span>{children}</span>
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        void runRendererPromise(desktop.openExternalUrl(href)).catch(() => undefined)
      }}
    >
      {children}
    </a>
  )
}

const MarkdownTable = ({ children }: ComponentProps<"table">) => (
  <div className="overflow-x-auto">
    <table>{children}</table>
  </div>
)

const MarkdownImage = ({ alt, src }: ComponentProps<"img">) => {
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const allowedSource =
    src !== undefined && Schema.is(WebUrl)(src) && new URL(src).protocol === "https:" ? src : null

  if (allowedSource === null || failedSource === allowedSource) {
    return (
      <span className="bg-muted text-muted-foreground inline-flex rounded-md border px-2 py-1 text-xs">
        Image unavailable{alt === undefined || alt.length === 0 ? "" : `: ${alt}`}
      </span>
    )
  }

  return (
    <img
      src={allowedSource}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSource(allowedSource)}
    />
  )
}

const markdownComponents = {
  a: MarkdownExternalLink,
  img: MarkdownImage,
  table: MarkdownTable,
}
