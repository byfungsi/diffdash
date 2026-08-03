import {
  annotate,
  click,
  clip,
  defineStory,
  pause,
  press,
  release,
  type,
  waitFor,
} from "../builder"

const projectButton = {
  button: "Open project emberline/dispatch",
  exact: true,
} as const
const hostedReviewButton = {
  button: "Open review #417: Make webhook replay claims atomic",
  exact: true,
} as const
const reviewsButton = { button: "Reviews", exact: true } as const
const filesButton = { button: "Files", exact: true } as const
const walkthroughButton = { button: "Walkthrough", exact: true } as const
const threadsButton = { button: "Threads", exact: true } as const
const reviewActions = { button: "Review actions", exact: true } as const
const walkthroughStep = {
  button: "Select walkthrough step 2: Acquire or recover in one statement",
  exact: true,
} as const

const openProject = () =>
  [
    waitFor(projectButton, 15_000),
    click(projectButton),
    waitFor(hostedReviewButton, 15_000),
  ] as const

const openHostedReview = () =>
  [...openProject(), click(hostedReviewButton), waitFor(reviewActions, 15_000), pause(400)] as const

/** Project-centered release reel introducing the persistent DiffDash workspace. */
export const projectWorkspaceStory = defineStory({
  id: "project-workspace",
  title: "DiffDash Project Workspace",
  intro: {
    step: "",
    eyebrow: "DiffDash · All New",
    title: "One Project. Every Review.",
    caption: "Local changes, pull requests, walkthroughs, and threads in one persistent workspace.",
  },
  outro: {
    step: "",
    eyebrow: "DiffDash · Project Workspace",
    title: "Stay in the Project",
    caption: "Move through the review without losing the code, conversation, or your place.",
  },
  clips: [
    clip(
      "1-project-home",
      {
        step: "01",
        eyebrow: "Project Home",
        title: "Projects, Not Pages",
        caption: "Pin active work, keep recent projects close, and enter one durable workspace.",
      },
      [
        waitFor({ text: "Pinned projects", exact: true }, 15_000),
        annotate(
          { text: "Pinned projects", exact: true },
          "Home is now a focused project launcher, with pinned and recent work kept in clear sections.",
          { title: "Project-centered Home", placement: "bottom", hold: 2_500 },
        ),
        click({ button: "Unpin emberline/dispatch", exact: true }),
        waitFor({ text: "Recent projects", exact: true }),
        annotate(
          projectButton,
          "Unpinned work moves into Recent projects without disappearing from the workspace.",
          { title: "Recent projects", placement: "left", hold: 2_300 },
        ),
        click(projectButton),
        waitFor(hostedReviewButton, 15_000),
        pause(500),
      ],
    ),
    clip(
      "2-review-sources",
      {
        step: "02",
        eyebrow: "Reviews",
        title: "Local and Hosted, Together",
        caption: "Working-tree changes and hosted pull requests are peer review sources.",
      },
      [
        waitFor({ text: "Pinned projects", exact: true }, 15_000),
        release("navigation-working-tree"),
        waitFor(filesButton, 15_000),
        click(reviewsButton),
        waitFor({ button: "Open working tree review", exact: true }, 15_000),
        waitFor(hostedReviewButton, 15_000),
        annotate(
          { button: "Open working tree review", exact: true },
          "The linked working tree appears first, beside every open pull request for the project.",
          { title: "One review queue", placement: "right", hold: 2_700 },
        ),
        click(hostedReviewButton),
        waitFor(reviewActions, 15_000),
        annotate(
          filesButton,
          "Selecting any review opens its files without leaving the project workspace.",
          { title: "Same workspace", placement: "right", hold: 2_300 },
        ),
      ],
    ),
    clip(
      "3-project-ribbons",
      {
        step: "03",
        eyebrow: "Workspace",
        title: "Change the Task, Keep the Diff",
        caption: "Reviews, Files, Walkthrough, and Threads share one stable project shell.",
      },
      [
        ...openHostedReview(),
        annotate(
          filesButton,
          "Four peer activities organize the work while the selected review stays mounted.",
          { title: "Project activities", placement: "right", hold: 2_500 },
        ),
        click(walkthroughButton),
        waitFor({ text: "Review focus", exact: true }),
        click(threadsButton),
        waitFor({ role: "complementary", name: "Review threads", exact: true }),
        click(reviewsButton),
        waitFor(hostedReviewButton),
        annotate(
          hostedReviewButton,
          "Return to the review queue and the active diff remains exactly where it was.",
          { title: "Context preserved", placement: "right", hold: 2_500 },
        ),
        click(filesButton),
        pause(500),
      ],
    ),
    clip(
      "4-review-navigation",
      {
        step: "04",
        eyebrow: "Review Navigation",
        title: "Navigate the Whole Change",
        caption: "Move from an AI-guided step to an exact match anywhere in the review.",
      },
      [
        ...openHostedReview(),
        click(walkthroughButton),
        waitFor({ text: "Review focus", exact: true }),
        click(walkthroughStep),
        annotate(
          walkthroughStep,
          "Walkthrough steps keep their complete source path and jump to the relevant hunk.",
          { title: "Guided navigation", placement: "right", hold: 2_600 },
        ),
        press(reviewActions, "Meta+f"),
        waitFor({ textbox: "Search review diff", exact: true }),
        type({ textbox: "Search review diff", exact: true }, "delivery_id"),
        waitFor({ button: "Next match", exact: true }),
        click({ button: "Next match", exact: true }),
        annotate(
          { textbox: "Search review diff", exact: true },
          "Review search traverses the complete immutable snapshot, including files beyond the viewport.",
          { title: "Whole-review search", placement: "bottom", hold: 2_700 },
        ),
        press({ textbox: "Search review diff", exact: true }, "Escape"),
        pause(500),
      ],
    ),
    clip(
      "5-durable-threads",
      {
        step: "05",
        eyebrow: "Review Threads",
        title: "Conversations Stay Attached",
        caption: "Ask beside exact code and keep the answer anchored to the reviewed line.",
      },
      [
        ...openHostedReview(),
        click(threadsButton),
        waitFor({ role: "complementary", name: "Review threads", exact: true }),
        click({
          button: /Open thread details for packages\/db\/src\/replay-claims\.ts\s+R20/,
        }),
        waitFor({ role: "complementary", name: "Thread details", exact: true }),
        type(
          { textbox: "Thread message", exact: true },
          "Can two regions disagree if their worker clocks drift?",
        ),
        click({ button: "Send", exact: true }),
        waitFor({ text: "Preparing review context...", exact: true }, 15_000),
        annotate(
          { text: "Preparing review context...", exact: true },
          "Agent progress stays visible inside the durable conversation instead of replacing it.",
          { title: "Visible progress", placement: "top", hold: 2_300 },
        ),
        release("turn-lease-follow-up"),
        waitFor({ text: /Revision 2 closes that gap/ }, 15_000),
        annotate(
          { text: /Revision 2 closes that gap/ },
          "The completed answer remains attached to replay-claims.ts and its exact review context.",
          { title: "Context preserved", placement: "top", hold: 2_800 },
        ),
        click({ button: "Go to thread in diff", exact: true }),
        waitFor(filesButton),
        pause(500),
      ],
    ),
    clip(
      "6-workspace-memory",
      {
        step: "06",
        eyebrow: "Workspace Memory",
        title: "Leave and Return",
        caption: "Each project remembers the selected review, active ribbon, and review position.",
      },
      [
        ...openHostedReview(),
        click(walkthroughButton),
        waitFor({ text: "Review focus", exact: true }),
        click(walkthroughStep),
        pause(900),
        click({ button: "Back", exact: true }),
        waitFor({ text: "Pinned projects", exact: true }, 15_000),
        click(projectButton),
        waitFor({ text: "Review focus", exact: true }, 15_000),
        annotate(
          walkthroughButton,
          "Reopening the project restores the selected pull request and the activity used last.",
          { title: "Workspace restored", placement: "right", hold: 3_000 },
        ),
        pause(600),
      ],
    ),
  ],
})
