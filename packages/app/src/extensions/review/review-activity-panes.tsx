import { createContext, type ReactNode, use } from "react"

interface ReviewActivityPaneContent {
  readonly reviewsContext: ReactNode
  readonly filesContext: ReactNode
}

const ReviewActivityPaneContext = createContext<ReviewActivityPaneContent | null>(null)

/** Supplies Review-owned context panes to the Reviews and Files activity slots. */
export const ReviewActivityPaneProvider = ({
  children,
  filesContext,
  reviewsContext,
}: ReviewActivityPaneContent & { readonly children: ReactNode }) => (
  <ReviewActivityPaneContext value={{ filesContext, reviewsContext }}>
    {children}
  </ReviewActivityPaneContext>
)

const useReviewActivityPaneContent = (): ReviewActivityPaneContent => {
  const content = use(ReviewActivityPaneContext)
  if (content === null) throw new Error("Review activity pane provider is unavailable")
  return content
}

/** Renders the review selector owned by the Reviews activity. */
export const ReviewsActivityContextPane = () => useReviewActivityPaneContent().reviewsContext

/** Renders the changed-file tree owned by the Files activity. */
export const FilesActivityContextPane = () => useReviewActivityPaneContent().filesContext
