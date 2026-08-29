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

const projectButton = { button: "Open project emberline/dispatch", exact: true } as const
const hostedReviewButton = {
  button: "Open review #417: Make webhook replay claims atomic",
  exact: true,
} as const
const filesButton = { button: "Files", exact: true } as const
const codeButton = { button: "Code", exact: true } as const
const commentsButton = { button: "Comments", exact: true } as const
const reviewsButton = { button: "Reviews", exact: true } as const

const openProject = () =>
  [
    waitFor(projectButton, 15_000),
    click(projectButton),
    waitFor(hostedReviewButton, 15_000),
  ] as const

const openReviewOverview = () =>
  [
    ...openProject(),
    click(hostedReviewButton),
    waitFor({ button: "Open diff", exact: true }, 15_000),
    pause(400),
  ] as const

const openReviewDiff = () =>
  [
    ...openReviewOverview(),
    click({ button: "Open diff", exact: true }),
    waitFor(filesButton, 15_000),
    waitFor({ text: "services/webhooks/src/replay/claim-delivery.ts", exact: true }, 15_000),
    pause(400),
  ] as const

const modifierClickReviewToken = (text: string, modifiers: readonly ("Meta" | "Shift")[]) =>
  raw(`modifier-click review token ${text}`, async ({ page }) => {
    const reviewCard = page.locator(
      '[data-diff-card-path="services/webhooks/src/replay/claim-delivery.ts"]',
    )
    await reviewCard.scrollIntoViewIfNeeded()
    const token = reviewCard
      .locator("diffs-container [data-char]")
      .filter({ hasText: text })
      .first()
    await token.waitFor({ state: "visible" })
    await token.click({ modifiers: [...modifiers] })
  })

const modifierClickCodeToken = (text: string, modifiers: readonly ("Meta" | "Shift")[]) =>
  raw(`modifier-click Code token ${text}`, async ({ page }) => {
    const token = page
      .locator("[data-code-file-scroll] diffs-container [data-char]")
      .filter({ hasText: text })
      .first()
    await token.waitFor({ state: "visible" })
    await token.click({ modifiers: [...modifiers] })
  })

const selectCodeLine = (lineIndex: number) =>
  raw(`select code line ${lineIndex + 1}`, async ({ page }) => {
    const line = page.locator(`diffs-container [data-line-index="${lineIndex}"]`).first()
    await line.waitFor({ state: "visible" })
    await line.click()
  })

/** Narrated end-to-end pull request workflow from first review through guarded merge. */
export const flagshipReviewWorkflowStory = defineStory({
  id: "flagship-review-workflow",
  title: "DiffDash Flagship Review Workflow",
  intro: {
    step: "",
    eyebrow: "DiffDash · Complete Review Workflow",
    title: "From First Look to Final Merge",
    caption: "One risky pull request. Every decision anchored to the code.",
  },
  outro: {
    step: "",
    eyebrow: "DiffDash · Desktop Review Workspace",
    title: "Review Without Losing Context",
    caption: "Hosted or local. Human or agent. Every path stays attached to the revision.",
  },
  clips: [
    clip(
      "1-pr-overview",
      {
        step: "01",
        eyebrow: "Pull Request Overview",
        title: "Start with the Decision Context",
        caption: "Conversation, checks, branches, commits, and merge readiness in one view.",
      },
      [
        ...openReviewOverview(),
        annotate(
          { role: "heading", name: "Make webhook replay claims atomic", exact: true },
          "The review begins with intent, rollout context, and the exact branches under review.",
          { title: "Understand the change", placement: "bottom", hold: 2_400 },
        ),
        annotate(
          { text: /should lease expiry trust clocks/ },
          "Provider conversation stays visible beside checks and merge readiness.",
          { title: "Review history included", placement: "top", hold: 2_500 },
        ),
        annotate(
          { text: "Build and test", exact: true },
          "Required checks are part of the decision, not a separate browser tab.",
          { title: "Provider status", placement: "left", hold: 2_200 },
        ),
        click({ button: "Review", exact: true }),
        waitFor({ role: "dialog", name: "Submit review", exact: true }),
        annotate(
          { role: "dialog", name: "Submit review", exact: true },
          "Approve, request changes, or leave a provider comment from the same overview.",
          { title: "Review actions", placement: "left", hold: 2_600 },
        ),
        press({ role: "dialog", name: "Submit review", exact: true }, "Escape"),
        pause(15_000),
      ],
    ),
    clip(
      "2-diff-symbol-navigation",
      {
        step: "02",
        eyebrow: "Diff Navigation",
        title: "Trace the Change Without Losing the Diff",
        caption: "Expand context, follow definitions, and choose references from Peek.",
      },
      [
        ...openReviewDiff(),
        modifierClickReviewToken("claimDelivery", ["Meta", "Shift"]),
        waitFor({ role: "dialog", name: /Peek References, 2 results/ }, 15_000),
        click({ button: /^claim-delivery\.test\.ts services/ }),
        annotate(
          { role: "dialog", name: /Peek References, 2 results/ },
          "Command-shift-click opens references in place. Select a result, then Command-D to go there.",
          { title: "Peek References", placement: "left", hold: 3_000 },
        ),
        press({ role: "dialog", name: /Peek References, 2 results/ }, "Meta+d"),
        waitFor(codeButton, 15_000),
        waitFor({ role: "treeitem", name: /claim-delivery\.test\.ts/ }, 15_000),
        pause(15_000),
      ],
    ),
    clip(
      "3-hosted-code-workspace",
      {
        step: "03",
        eyebrow: "Repository Code",
        title: "Open PR Files Without a Checkout",
        caption: "Browse the hosted head revision through a managed, exact-revision workspace.",
      },
      [
        ...openReviewDiff(),
        modifierClickReviewToken("claimDelivery", ["Meta"]),
        waitFor(codeButton, 15_000),
        waitFor({ text: "packages/db/src/replay-claims.ts", exact: true }, 15_000),
        annotate(
          { role: "tree", name: "Repository files", exact: true },
          "This project is still remote-only. DiffDash materializes the PR revision without touching a local checkout.",
          { title: "Hosted code workspace", placement: "right", hold: 3_100 },
        ),
        press(codeButton, "Meta+k"),
        waitFor({ placeholder: "Search repository files", exact: true }),
        type({ placeholder: "Search repository files", exact: true }, "claim-delivery.test"),
        click({ text: "claim-delivery.test.ts", exact: true }),
        waitFor({ text: /uses database time|grants an active replay lease/ }, 15_000),
        pause(15_700),
      ],
    ),
    clip(
      "4-code-symbol-navigation",
      {
        step: "04",
        eyebrow: "Code Navigation",
        title: "Use the Same Language Tools in Code",
        caption: "Definitions, references, Peek selection, and history work across surfaces.",
      },
      [
        release("revision-updated"),
        ...openReviewDiff(),
        modifierClickReviewToken("claimDelivery", ["Meta"]),
        waitFor(codeButton, 15_000),
        modifierClickCodeToken("claimDelivery", ["Meta", "Shift"]),
        waitFor({ role: "dialog", name: /Peek References, 2 results/ }, 15_000),
        click({ button: /^claim-delivery\.test\.ts services/ }),
        press({ role: "dialog", name: /Peek References, 2 results/ }, "Meta+d"),
        waitFor({ text: /uses database time when regional worker clocks disagree/ }, 15_000),
        modifierClickCodeToken("replayDelivery", ["Meta"]),
        waitFor({ text: "services/webhooks/src/replay/claim-delivery.ts", exact: true }, 15_000),
        annotate(
          codeButton,
          "Code uses the same modifier-clicks and keeps each jump in global Back and Forward history.",
          { title: "One navigation model", placement: "right", hold: 2_800 },
        ),
        pause(15_000),
      ],
    ),
    clip(
      "5-diffdash-agent-conversation",
      {
        step: "05",
        eyebrow: "Review Comments",
        title: "Discuss the Risk Beside the Code",
        caption: "A DiffDash agent conversation remains anchored to the reviewed line.",
      },
      [
        ...openReviewDiff(),
        click(commentsButton),
        waitFor({ role: "complementary", name: "Review threads", exact: true }),
        click({ button: /Open thread details for packages\/db\/src\/replay-claims\.ts\s+R20/ }),
        waitFor({ role: "complementary", name: "Thread details", exact: true }),
        type(
          { textbox: "Thread message", exact: true },
          "Can two regions disagree if their worker clocks drift?",
        ),
        click({ button: "Send", exact: true }),
        waitFor({ text: "Preparing review context...", exact: true }, 15_000),
        annotate(
          { text: "Preparing review context...", exact: true },
          "Progress stays visible while the conversation and exact line remain available.",
          { title: "Agent working in context", placement: "top", hold: 2_500 },
        ),
        release("turn-lease-follow-up"),
        waitFor({ text: /Revision 2 closes that gap/ }, 15_000),
        annotate(
          { text: /Revision 2 closes that gap/ },
          "The answer becomes another durable turn, not a detached chat transcript.",
          { title: "Back-and-forth review", placement: "top", hold: 2_800 },
        ),
        pause(15_000),
        click({ button: "Go to thread in diff", exact: true }),
        waitFor(filesButton, 15_000),
        raw("expand exact diff context", async ({ page }) => {
          const card = page.locator(
            '[data-diff-card-path="apps/ops/src/routes/webhook-replays.tsx"]',
          )
          await card.scrollIntoViewIfNeeded()
          const expand = card.locator("diffs-container [data-expand-button]").first()
          await expand.waitFor({ state: "visible" })
          await expand.click()
        }),
        pause(700),
      ],
    ),
    clip(
      "6-request-changes",
      {
        step: "06",
        eyebrow: "Review Decision",
        title: "Request the Fix from the Overview",
        caption: "Record a provider decision with the technical reason attached.",
      },
      [
        ...openReviewOverview(),
        click({ button: "Review", exact: true }),
        waitFor({ role: "dialog", name: "Submit review", exact: true }),
        click({ button: "Request changes", exact: true }),
        type(
          { placeholder: "Leave a review comment", exact: true },
          "Please use database time for lease creation and expiry, then cover workers with skewed clocks.",
        ),
        annotate(
          { role: "dialog", name: "Submit review", exact: true },
          "The requested change carries the reasoning discovered in the diff and agent conversation.",
          { title: "Actionable review feedback", placement: "left", hold: 2_800 },
        ),
        click({ button: "Submit review", exact: true }),
        waitFor({ text: /Please use database time for lease creation/ }, 15_000),
        pause(15_000),
      ],
    ),
    clip(
      "7-send-to-opencode",
      {
        step: "07",
        eyebrow: "Developer Handoff",
        title: "Send Exact Code Context to OpenCode",
        caption: "Forward an anchored implementation note to a project session in plan mode.",
      },
      [
        release("revision-updated"),
        release("checkout-linked"),
        type({ placeholder: "Search local and hosted projects", exact: true }, "emberline"),
        waitFor({ button: /emberline\/dispatch Hosted \+ local/ }, 15_000),
        click({ button: /emberline\/dispatch Hosted \+ local/ }),
        waitFor(hostedReviewButton, 15_000),
        click({ button: "Connect AI", exact: true }),
        raw("open OpenCode sessions", async ({ page }) => {
          await page.getByText("OpenCode", { exact: true }).last().hover()
          await page.waitForTimeout(800)
        }),
        waitFor({ textbox: "Search OpenCode sessions", exact: true }, 15_000),
        raw("choose OpenCode session", async ({ page }) => {
          const session = page.getByRole("menuitem", { name: /Review atomic replay claims/ })
          await session.waitFor({ state: "visible" })
          await session.evaluate((element) => {
            if (element instanceof HTMLElement) element.click()
          })
        }),
        waitFor({ button: "OpenCode · Review atomic replay claims", exact: true }, 15_000),
        click(hostedReviewButton),
        waitFor({ button: "Open diff", exact: true }, 15_000),
        click({ button: "Open diff", exact: true }),
        waitFor(filesButton, 15_000),
        modifierClickReviewToken("claimDelivery", ["Meta"]),
        waitFor(codeButton, 15_000),
        selectCodeLine(9),
        click(commentsButton),
        waitFor({ textbox: "Code comment", exact: true }),
        type(
          { textbox: "Code comment", exact: true },
          "Please verify the database-clock fix remains idempotent when two regions race after expiry.",
        ),
        annotate(
          { button: /Send to OpenCode/ },
          "DiffDash forwards the committed revision, path, line, and source to the connected OpenCode session.",
          { title: "An exact developer handoff", placement: "left", hold: 3_000 },
        ),
        click({ button: /Send to OpenCode/ }),
        pause(15_700),
      ],
    ),
    clip(
      "8-approve-and-merge",
      {
        step: "08",
        eyebrow: "Guarded Merge",
        title: "Approve the Revision You Verified",
        caption: "Choose the merge strategy and mutate only the displayed head revision.",
      },
      [
        release("revision-updated"),
        ...openReviewOverview(),
        annotate(
          { text: /Database time and the skewed-clock test/ },
          "The revised provider conversation confirms the requested fix is ready for another look.",
          { title: "Revision addressed", placement: "top", hold: 2_500 },
        ),
        click({ button: "Review", exact: true }),
        waitFor({ role: "dialog", name: "Submit review", exact: true }),
        click({ button: "Approve", exact: true }),
        click({ button: "Submit review", exact: true }),
        waitFor({ button: "Merge", exact: true }, 15_000),
        click({ button: "Merge", exact: true }),
        waitFor({ role: "dialog", name: "Merge pull request", exact: true }),
        annotate(
          { role: "dialog", name: "Merge pull request", exact: true },
          "Checks, permissions, merge strategy, and the exact head SHA still guard the final action.",
          { title: "Merge with confidence", placement: "left", hold: 3_000 },
        ),
        click({ button: "Merge pull request", exact: true }),
        pause(900),
        click(reviewsButton),
        pause(15_000),
      ],
    ),
  ],
})
