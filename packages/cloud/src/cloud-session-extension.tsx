import {
  TrustedExtensionId,
  TrustedExtensionContributionId,
  type TrustedBuiltInExtension,
} from "@diffdash/app"
import { LogOut } from "lucide-react"
import { clearGithubPersonalAccessToken } from "./github-credentials"
import { captureCloudEvent, resetCloudAnalytics } from "./cloud-analytics"

const CloudSessionAction = () => (
  <button
    type="button"
    className="text-shell-titlebar-muted hover:bg-shell-titlebar-control-hover focus-visible:ring-ring inline-flex size-8 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
    aria-label="Disconnect GitHub account"
    title="Disconnect GitHub account"
    onClick={() => {
      clearGithubPersonalAccessToken()
      void captureCloudEvent({ event: "github_disconnected" })
      resetCloudAnalytics()
      window.location.reload()
    }}
  >
    <LogOut className="size-3.5" />
  </button>
)

/** Web-owned session action in registered titlebar chrome, never overlaying mobile review ribbons. */
export const cloudSessionExtension: TrustedBuiltInExtension = {
  id: TrustedExtensionId.make("diffdash.cloud.session"),
  titlebarActions: [
    {
      id: TrustedExtensionContributionId.make("diffdash.cloud.session.disconnect"),
      order: 900,
      component: CloudSessionAction,
    },
  ],
}
