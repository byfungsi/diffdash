import { cn } from "@/shared/utils"

/** Renders complete accessible text while preferentially preserving its trailing path segment. */
export const MiddleTruncatedText = ({
  className,
  value,
}: {
  readonly className?: string
  readonly value: string
}) => {
  const leafIndex = value.lastIndexOf("/") + 1
  const splitIndex =
    leafIndex > 0 && value.length - leafIndex <= 25 ? leafIndex : Math.ceil(value.length / 2)
  const prefix = value.slice(0, splitIndex)
  const suffix = value.slice(splitIndex)

  return (
    <span
      aria-label={value}
      title={value}
      className={cn("flex min-w-0 max-w-full overflow-hidden whitespace-nowrap", className)}
    >
      <span className="min-w-0 overflow-hidden text-ellipsis [flex:0_999999_max-content]">
        {prefix}
      </span>
      <span className="min-w-0 overflow-hidden text-ellipsis [direction:rtl] [flex:0_1_max-content] [text-align:left]">
        {suffix}
      </span>
    </span>
  )
}
