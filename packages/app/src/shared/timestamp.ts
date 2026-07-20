/** Formats a timestamp in the renderer locale without throwing for invalid input. */
export const formatTimestamp = (value: string, invalidFallback: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return invalidFallback
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}
