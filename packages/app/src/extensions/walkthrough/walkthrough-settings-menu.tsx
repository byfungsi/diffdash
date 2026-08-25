import { AIProviderId, AISettings } from "@diffdash/domain/ai-settings"
import type { AgentProviderCatalog } from "@diffdash/protocol/agent-providers"
import { Check, Settings2 } from "lucide-react"
import { DropdownMenu } from "radix-ui"
import { useState } from "react"

import {
  agentProviderOptions,
  agentSelection,
  aiSettingsWithModel,
  aiSettingsWithProvider,
  modelOptionsForProvider,
  selectedModelForProvider,
  selectedProvider,
} from "@/settings/agent-selection"
import { Button } from "@/shared/ui/button"

/** Agent routing settings owned by the Walkthrough extension. */
export const WalkthroughSettingsMenu = ({
  catalog,
  settings,
  onChange,
}: {
  readonly catalog: AgentProviderCatalog
  readonly settings: AISettings
  readonly onChange: (settings: AISettings) => void
}) => {
  const [open, setOpen] = useState(false)
  const walkthroughSelection = agentSelection(settings, "walkthrough")
  const reviewThreadSelection = agentSelection(settings, "review-thread")
  const groups = [
    {
      label: "Walkthrough agent",
      value: selectedProvider(walkthroughSelection),
      options: agentProviderOptions(catalog, walkthroughSelection, "walkthrough").map((option) => ({
        ...option,
        value: option.provider,
      })),
      onChange: (provider: string) =>
        onChange(
          aiSettingsWithProvider(
            settings,
            "walkthrough",
            provider === "auto" ? "auto" : AIProviderId.make(provider),
            catalog,
          ),
        ),
    },
    {
      label: "Walkthrough model",
      value: selectedModelForProvider(walkthroughSelection),
      options: modelOptionsForProvider(walkthroughSelection, catalog, "walkthrough").map(
        (option) => ({
          ...option,
          value: option.model,
        }),
      ),
      onChange: (model: string) => onChange(aiSettingsWithModel(settings, "walkthrough", model)),
    },
    {
      label: "Review comment agent",
      value: selectedProvider(reviewThreadSelection),
      options: agentProviderOptions(catalog, reviewThreadSelection, "review-thread").map(
        (option) => ({
          ...option,
          value: option.provider,
        }),
      ),
      onChange: (provider: string) =>
        onChange(
          aiSettingsWithProvider(
            settings,
            "review-thread",
            provider === "auto" ? "auto" : AIProviderId.make(provider),
            catalog,
          ),
        ),
    },
    {
      label: "Review comment model",
      value: selectedModelForProvider(reviewThreadSelection),
      options: modelOptionsForProvider(reviewThreadSelection, catalog, "review-thread").map(
        (option) => ({
          ...option,
          value: option.model,
        }),
      ),
      onChange: (model: string) => onChange(aiSettingsWithModel(settings, "review-thread", model)),
    },
  ]

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Agent settings"
          className="text-review-sidebar-muted hover:bg-review-sidebar-control-hover hover:text-review-sidebar-fg"
          onClick={(event) => {
            if (event.detail === 0) setOpen((value) => !value)
          }}
        >
          <Settings2 className="size-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Agent settings"
          align="end"
          sideOffset={8}
          className="bg-review-sidebar border-review-sidebar-divider text-review-sidebar-fg z-30 w-72 space-y-1 rounded-xl border p-2 text-xs shadow-lg"
        >
          {groups.map((group, index) => (
            <DropdownMenu.RadioGroup
              key={group.label}
              className={
                index === 0 ? "space-y-1" : "border-review-sidebar-divider space-y-1 border-t pt-2"
              }
              value={group.value}
              onValueChange={group.onChange}
            >
              <DropdownMenu.Label className="text-caption text-review-sidebar-muted px-2 font-semibold tracking-wide uppercase">
                {group.label}
              </DropdownMenu.Label>
              {group.options.map((option) => (
                <DropdownMenu.RadioItem
                  key={option.value}
                  asChild
                  value={option.value}
                  disabled={option.disabled}
                  onSelect={(event) => event.preventDefault()}
                >
                  <button
                    type="button"
                    disabled={option.disabled}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      group.value === option.value
                        ? "bg-review-sidebar-control-active text-review-sidebar-fg"
                        : "text-review-sidebar-muted hover:bg-review-sidebar-control-hover hover:text-review-sidebar-fg"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{option.label}</span>
                      {option.reason === null ? null : (
                        <span className="text-caption block text-pretty opacity-75">
                          {option.reason}
                        </span>
                      )}
                    </span>
                    {group.value === option.value ? <Check className="size-3" /> : null}
                  </button>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
