import {
  annotate,
  click,
  clip,
  defineStory,
  pause,
  press,
  raw,
  release,
  type,
  waitFor,
} from "../builder"

const reviewButton = {
  button: "Open requested review #417: Make webhook replay claims atomic",
  exact: true,
} as const
const walkthroughButton = { button: "Walkthrough", exact: true } as const
const reviewActions = { button: "Actions", exact: true } as const
const reviewThreads = { role: "heading", name: "Review threads", exact: true } as const

const openReview = () =>
  [
    waitFor(reviewButton, 15_000),
    click(reviewButton),
    waitFor(reviewThreads, 15_000),
    pause(900),
  ] as const

/** Xenith-style seven-clip release reel for DiffDash v0.4.3. */
export const diffDash043Story = defineStory({
  id: "diffdash-0.4.3",
  title: "DiffDash 0.4.3 Release",
  intro: {
    step: "",
    eyebrow: "DiffDash · Desktop Release",
    title: "Release 0.4.3",
    caption:
      "Sharper review navigation, clearer walkthrough paths, and the complete desktop review workflow.",
  },
  outro: {
    step: "",
    eyebrow: "DiffDash · Desktop Release",
    title: "That’s a wrap",
    caption: "Seven focused workflows. One place to understand every change before it ships.",
  },
  clips: [
    clip(
      "1-repository-discovery",
      {
        step: "01",
        eyebrow: "Repositories",
        title: "Find & Bookmark Repositories",
        caption: "Search beyond saved work and keep important repositories one click away.",
      },
      [
        click({ button: "Remove bookmark for emberline/dispatch", exact: true }),
        type(
          { placeholder: "Search bookmarked and accessible repositories", exact: true },
          "emberline/dispatch",
        ),
        waitFor({ button: "Bookmark", exact: true }),
        annotate(
          { button: "Bookmark", exact: true },
          "Accessible repositories appear in the same search and can be saved immediately.",
          { title: "Repository discovery", placement: "left", hold: 3_200 },
        ),
        click({ button: "Bookmark", exact: true }),
        pause(1_100),
      ],
    ),
    clip(
      "2-scoped-navigation",
      {
        step: "02",
        eyebrow: "Review Navigation",
        title: "Search the Active Workspace",
        caption: "Go Anywhere now follows the active Files or Walkthrough sidebar.",
      },
      [
        ...openReview(),
        press(reviewActions, "Meta+k"),
        waitFor({ placeholder: "Search files", exact: true }),
        annotate(
          { placeholder: "Search files", exact: true },
          "With Files active, Go Anywhere searches only the review file inventory.",
          { title: "Active sidebar", placement: "bottom", hold: 3_000 },
        ),
        press({ placeholder: "Search files", exact: true }, "Escape"),
        click(walkthroughButton),
        waitFor({ text: "Review focus", exact: true }),
        press(walkthroughButton, "Meta+k"),
        waitFor({ placeholder: "Search walkthrough sections", exact: true }),
        annotate(
          { placeholder: "Search walkthrough sections", exact: true },
          "Switch to Walkthrough and the same shortcut searches walkthrough sections instead.",
          { title: "Scoped navigation", placement: "bottom", hold: 3_300 },
        ),
        pause(700),
      ],
    ),
    clip(
      "3-walkthrough-paths",
      {
        step: "03",
        eyebrow: "AI Walkthrough",
        title: "Full Paths, Clear Context",
        caption: "Walkthrough sections identify the exact file even when basenames repeat.",
      },
      [
        ...openReview(),
        click(walkthroughButton),
        waitFor({ text: "Review focus", exact: true }),
        click({
          button: "Select walkthrough step 2: Acquire or recover in one statement",
          exact: true,
        }),
        annotate(
          {
            button: "Select walkthrough step 2: Acquire or recover in one statement",
            exact: true,
          },
          "Each section keeps its complete source path visible, removing ambiguity in large reviews.",
          { title: "Path clarity", placement: "right", hold: 3_500 },
        ),
        pause(900),
      ],
    ),
    clip(
      "4-diff-search",
      {
        step: "04",
        eyebrow: "Diff Navigation",
        title: "Search the Entire Review",
        caption: "Find code across the immutable snapshot and reveal hidden context when needed.",
      },
      [
        ...openReview(),
        press(reviewActions, "Meta+f"),
        waitFor({ textbox: "Search review diff", exact: true }),
        type({ textbox: "Search review diff", exact: true }, "delivery_id"),
        waitFor({ button: "Next match", exact: true }),
        click({ button: "Next match", exact: true }),
        annotate(
          { textbox: "Search review diff", exact: true },
          "Search traverses the full snapshot, including files that are not currently mounted on screen.",
          { title: "Full diff search", placement: "bottom", hold: 3_200 },
        ),
        press({ textbox: "Search review diff", exact: true }, "Escape"),
        click(reviewActions),
        click({ role: "menuitem", name: "Reveal hidden files" }),
        annotate(
          { text: "Make webhook replay claims atomic", exact: true },
          "Generated, lock, and binary files stay quiet until the reviewer asks for the extra context.",
          { title: "Noise control", placement: "bottom", hold: 3_100 },
        ),
      ],
    ),
    clip(
      "5-agent-routing",
      {
        step: "05",
        eyebrow: "AI Review",
        title: "Route Work to the Right Agent",
        caption: "Choose independent providers and models for walkthroughs and review threads.",
      },
      [
        ...openReview(),
        click(walkthroughButton),
        waitFor({ text: "Review focus", exact: true }),
        click({ button: "Agent settings", exact: true }),
        waitFor({ role: "menu", name: "Agent settings", exact: true }),
        annotate(
          { role: "menu", name: "Agent settings", exact: true },
          "Claude, Codex, and OpenCode can be routed independently for walkthrough and review-thread work.",
          { title: "Agent routing", placement: "right", hold: 3_600 },
        ),
        pause(800),
      ],
    ),
    clip(
      "6-inline-review",
      {
        step: "06",
        eyebrow: "Review Threads",
        title: "Ask on the Exact Line",
        caption: "Human questions and agent answers remain attached to their code context.",
      },
      [
        ...openReview(),
        click(walkthroughButton),
        waitFor({ text: "Review focus", exact: true }),
        click({
          button: "Select walkthrough step 2: Acquire or recover in one statement",
          exact: true,
        }),
        click({ button: "packages/db/src/replay-claims.ts:20 · new", exact: true }),
        waitFor({ textbox: "Thread message", exact: true }),
        type(
          { textbox: "Thread message", exact: true },
          "Can two regions disagree if their worker clocks drift?",
        ),
        click({ button: "Send", exact: true }),
        waitFor({ text: "Preparing review context...", exact: true }, 15_000),
        annotate(
          { text: "Preparing review context...", exact: true },
          "DiffDash shows live agent progress without detaching the conversation from the reviewed line.",
          { title: "Visible progress", placement: "top", hold: 2_600 },
        ),
        release("turn-lease-follow-up"),
        waitFor({ text: /Revision 2 closes that gap/ }, 15_000),
        annotate(
          { text: /Revision 2 closes that gap/ },
          "The completed answer stays beside the code and remains available across revision updates.",
          { title: "Context preserved", placement: "top", hold: 3_400 },
        ),
      ],
    ),
    clip(
      "7-local-review",
      {
        step: "07",
        eyebrow: "Local Review",
        title: "Review Before You Push",
        caption:
          "Open working-tree changes and merge-base branch comparisons from the DiffDash CLI.",
      },
      [
        release("navigation-working-tree"),
        waitFor({ role: "heading", name: "Local changes", exact: true }, 15_000),
        annotate(
          { role: "heading", name: "Local changes", exact: true },
          "Tracked and untracked working-tree changes open directly as a complete local review.",
          { title: "Working tree", placement: "bottom", hold: 3_100 },
        ),
        click(walkthroughButton),
        waitFor({ text: "Review focus", exact: true }),
        pause(900),
        release("navigation-branch-diff"),
        waitFor({ role: "heading", name: "Changes vs dev", exact: true }, 15_000),
        annotate(
          { role: "heading", name: "Changes vs dev", exact: true },
          "Branch comparisons use the merge base, so unrelated target-only changes never pollute the review.",
          { title: "Merge-base comparison", placement: "bottom", hold: 3_500 },
        ),
        raw("hold final branch review", async ({ page }) => page.waitForTimeout(900)),
      ],
    ),
  ],
})
