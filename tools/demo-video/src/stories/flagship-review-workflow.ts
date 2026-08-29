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
      "1-triage-and-navigate",
      {
        step: "01",
        eyebrow: "Triage and Navigation",
        title: "Move from Risk to Exact Code",
        caption: "Start with review context, then follow definitions and references in place.",
      },
      [
        ...openReviewOverview(),
        annotate(
          { text: /should lease expiry trust clocks/ },
          "Intent, checks, and the clock-drift concern are visible before the first code jump.",
          { title: "Decision context first", placement: "top", hold: 1_400 },
        ),
        click({ button: "Open diff", exact: true }),
        waitFor(filesButton, 15_000),
        modifierClickReviewToken("claimDelivery", ["Meta"]),
        waitFor(codeButton, 15_000),
        waitFor({ text: "packages/db/src/replay-claims.ts", exact: true }, 15_000),
        click(filesButton),
        waitFor({ text: "services/webhooks/src/replay/claim-delivery.ts", exact: true }, 15_000),
        modifierClickReviewToken("claimDelivery", ["Meta", "Shift"]),
        waitFor({ role: "dialog", name: /Peek References, 2 results/ }, 15_000),
        click({ button: /^claim-delivery\.test\.ts services/ }),
        annotate(
          { role: "dialog", name: /Peek References, 2 results/ },
          "Command-shift-click opens references in place; Command-D follows the selected result.",
          { title: "Semantic navigation", placement: "left", hold: 1_500 },
        ),
        press({ role: "dialog", name: /Peek References, 2 results/ }, "Meta+d"),
        waitFor(codeButton, 15_000),
        waitFor({ role: "treeitem", name: /claim-delivery\.test\.ts/ }, 15_000),
        pause(500),
      ],
    ),
    clip(
      "2-agent-and-request-changes",
      {
        step: "02",
        eyebrow: "Agent and Review Decision",
        title: "Turn Investigation into Feedback",
        caption: "Resolve the risk beside the code, then request the exact fix.",
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
        release("turn-lease-follow-up"),
        waitFor({ text: /Revision 2 closes that gap/ }, 15_000),
        annotate(
          { text: /Revision 2 closes that gap/ },
          "The anchored answer identifies database time as the required transaction boundary.",
          { title: "Risk resolved in context", placement: "top", hold: 1_500 },
        ),
        click({ button: "Go to thread in diff", exact: true }),
        waitFor(filesButton, 15_000),
        click(reviewsButton),
        waitFor(hostedReviewButton, 15_000),
        click(hostedReviewButton),
        waitFor({ button: "Review", exact: true }, 15_000),
        click({ button: "Review", exact: true }),
        waitFor({ role: "dialog", name: "Submit review", exact: true }),
        click({ button: "Request changes", exact: true }),
        type(
          { placeholder: "Leave a review comment", exact: true },
          "Use database time for lease expiry and add a skewed-clock race test.",
        ),
        click({ button: "Submit review", exact: true }),
        waitFor({ text: /Use database time for lease expiry/ }, 15_000),
        pause(500),
      ],
    ),
    clip(
      "3-verify-and-handoff",
      {
        step: "03",
        eyebrow: "Revision Verification",
        title: "Verify the Fix and Hand It Off",
        caption: "Check the new revision, then send exact implementation context to OpenCode.",
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
        modifierClickCodeToken("claimDelivery", ["Meta", "Shift"]),
        waitFor({ role: "dialog", name: /Peek References, 2 results/ }, 15_000),
        click({ button: /^claim-delivery\.test\.ts services/ }),
        press({ role: "dialog", name: /Peek References, 2 results/ }, "Meta+d"),
        waitFor({ text: /uses database time when regional worker clocks disagree/ }, 15_000),
        modifierClickCodeToken("replayDelivery", ["Meta"]),
        waitFor({ text: /transaction_timestamp/ }, 15_000),
        selectCodeLine(9),
        click(commentsButton),
        waitFor({ textbox: "Code comment", exact: true }),
        type(
          { textbox: "Code comment", exact: true },
          "Verify this remains idempotent when two regions race after expiry.",
        ),
        annotate(
          { button: /Send to OpenCode/ },
          "The committed revision, path, line, and source travel with the implementation note.",
          { title: "Exact OpenCode handoff", placement: "left", hold: 1_500 },
        ),
        click({ button: /Send to OpenCode/ }),
        pause(500),
      ],
    ),
    clip(
      "4-approve-and-merge",
      {
        step: "04",
        eyebrow: "Guarded Merge",
        title: "Approve the Revision You Verified",
        caption: "Choose the merge strategy and mutate only the displayed head revision.",
      },
      [
        release("revision-updated"),
        ...openReviewOverview(),
        waitFor({ text: /Database time and the skewed-clock test/ }, 15_000),
        click({ button: "Review", exact: true }),
        waitFor({ role: "dialog", name: "Submit review", exact: true }),
        click({ button: "Approve", exact: true }),
        click({ button: "Submit review", exact: true }),
        waitFor({ button: "Merge", exact: true }, 15_000),
        click({ button: "Merge", exact: true }),
        waitFor({ role: "dialog", name: "Merge pull request", exact: true }),
        annotate(
          { role: "dialog", name: "Merge pull request", exact: true },
          "Checks, merge strategy, and the exact head SHA guard the final mutation.",
          { title: "Merge the verified head", placement: "left", hold: 1_500 },
        ),
        click({ button: "Merge pull request", exact: true }),
        pause(700),
        click(reviewsButton),
        pause(500),
      ],
    ),
  ],
})
