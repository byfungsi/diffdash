const walkthroughItems = [
  {
    title: "Snapshot restore waits for branch metadata before rendering",
    file: "restoreSnapshot.ts",
    changes: "+4 -1",
    active: true,
  },
  {
    title: "Approval toolbar keeps reviewer intent after refresh",
    file: "approvalToolbar.tsx",
    changes: "+6 -2",
    active: false,
  },
  {
    title: "Walkthrough queue folds completed notes by default",
    file: "walkthroughQueue.ts",
    changes: "+5 -1",
    active: false,
  },
]

const splitDiffRows = [
  {
    leftLine: "3",
    left: 'import { ReviewSnapshot } from "@aurora/review";',
    rightLine: "3",
    right: 'import { ReviewSnapshot } from "@aurora/review";',
    tone: "code",
  },
  {
    leftLine: "4",
    left: 'import { AuditTrail } from "@aurora/logging";',
    rightLine: "4",
    right: 'import { AuditTrail } from "@aurora/logging";',
    tone: "code",
  },
  {
    leftLine: "6",
    left: "",
    rightLine: "6",
    right: "// Keep restore idempotent while branch metadata loads.",
    tone: "added",
  },
  {
    leftLine: "7",
    left: "export async function restoreReviewSnapshot(",
    rightLine: "7",
    right: "export async function restoreReviewSnapshot(",
    tone: "code",
  },
]

const stats = [
  { value: "Local", label: "review memory stored on your machine" },
  { value: "GitHub", label: "PRs and local repositories in one queue" },
  { value: "AI", label: "walkthroughs that explain the risky parts" },
]

const workflows = [
  {
    step: "01",
    title: "Open any review",
    text: "Start from a GitHub PR, a local repository, or the DiffDash CLI without rebuilding your workspace.",
  },
  {
    step: "02",
    title: "Work file by file",
    text: "Track viewed files, move through hunks, and keep important notes connected to the code in front of you.",
  },
  {
    step: "03",
    title: "Ask for orientation",
    text: "Use AI walkthroughs to spot intent, edge cases, and follow-up questions before you leave comments.",
  },
]

const featureCards = [
  {
    label: "Review Memory",
    title: "Pick up where you stopped",
    text: "DiffDash remembers the files you have already inspected so large reviews feel like a queue, not a scavenger hunt.",
  },
  {
    label: "Local First",
    title: "No hosted source mirror",
    text: "Repository paths, PR metadata, and review state live in local services backed by SQLite.",
  },
  {
    label: "Desktop Focus",
    title: "Built for deep work",
    text: "A macOS-first shell keeps GitHub, local diffs, and guided review context in one durable workspace.",
  },
]

const terminalLines = [
  "$ diffdash .",
  "Opening local review workspace",
  "Loaded 18 changed files",
  "Restored 9 viewed files",
]

/** Promotional landing page for DiffDash. */
export function App() {
  return (
    <main className="page-shell">
      <header className="nav">
        <a className="brand" href="#top" aria-label="DiffDash home">
          <DiffDashMark />
          <span>DiffDash</span>
        </a>
        <nav className="nav-links" aria-label="Primary navigation">
          <a href="#workflow">Workflow</a>
          <a href="#privacy">Privacy</a>
          <a href="#download">Download</a>
        </nav>
        <a className="nav-cta" href="mailto:hello@diffdash.dev?subject=DiffDash%20early%20access">
          Early access
        </a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="launch-pill">
            <span /> Public Beta
          </p>
          <h1>Code review that keeps context attached.</h1>
          <p className="hero-text">
            DiffDash is a desktop review workspace for GitHub pull requests, local repositories, and
            AI-guided walkthroughs. Move through every changed file with memory, focus, and fewer
            browser tabs.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#download">
              Request early access
            </a>
            <a className="button button-secondary" href="#workflow">
              See the workflow
            </a>
          </div>
          <p className="hero-footnote">
            No cloud sync required. Designed around local repositories and GitHub CLI workflows.
          </p>
        </div>

        <ProductPreview />
      </section>

      <section className="stats" aria-label="DiffDash product highlights">
        {stats.map((stat) => (
          <article className="stat-card" key={stat.value}>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </article>
        ))}
      </section>

      <section className="section workflow-section" id="workflow">
        <div className="section-heading">
          <p className="eyebrow">Review Workflow</p>
          <h2>A calmer way to finish large pull requests.</h2>
          <p>
            DiffDash keeps the review state, changed files, and AI notes in one place so you can
            review deliberately instead of hopping between tabs.
          </p>
        </div>
        <div className="workflow-grid">
          {workflows.map((item) => (
            <article className="workflow-card" key={item.title}>
              <span>{item.step}</span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section feature-grid" id="privacy">
        {featureCards.map((feature) => (
          <article className="feature-card" key={feature.title}>
            <p className="eyebrow">{feature.label}</p>
            <h3>{feature.title}</h3>
            <p>{feature.text}</p>
          </article>
        ))}
      </section>

      <section className="section command-panel">
        <div>
          <p className="eyebrow">Launch From Anywhere</p>
          <h2>Start a review from the terminal.</h2>
          <p>
            Open DiffDash on the current repository, jump back into the running desktop app, and
            keep your review state attached to the repo.
          </p>
        </div>
        <div className="terminal-card" aria-label="DiffDash command line preview">
          <div className="terminal-bar">
            <span />
            <span />
            <span />
          </div>
          <pre>
            <code>
              {terminalLines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </code>
          </pre>
        </div>
      </section>

      <section className="section final-cta" id="download">
        <p className="eyebrow">Coming Soon</p>
        <h2>Make code review feel like a focused tool again.</h2>
        <p>
          Join early access for the DiffDash macOS desktop app and help shape the next review
          workflow for serious engineering teams.
        </p>
        <div className="hero-actions centered">
          <a
            className="button button-primary"
            href="mailto:hello@diffdash.dev?subject=DiffDash%20early%20access"
          >
            Request early access
          </a>
          <a className="button button-secondary" href="#top">
            Back to top
          </a>
        </div>
      </section>
    </main>
  )
}

function ProductPreview() {
  return (
    <div className="product-preview" aria-label="DiffDash product preview">
      <div className="preview-glow" />
      <div className="real-app-window">
        <aside className="real-sidebar" aria-label="Walkthrough sidebar preview">
          <div className="sidebar-chrome">
            <span />
            <span />
            <span />
            <strong>northstar-labs/aurora-console</strong>
          </div>
          <div className="sidebar-search">Filter files</div>
          <div className="model-row">Claude / Sonnet 5.0</div>
          <section className="sidebar-focus">
            <h3>Review focus</h3>
            <p>
              Focus review on snapshot restore behavior, queued walkthrough state, and reviewer
              approval controls.
            </p>
          </section>
          <div className="scope-row">
            <strong>Scope</strong>
            <span>Regenerate</span>
          </div>
          <div className="walkthrough-list">
            {walkthroughItems.map((item, index) => (
              <article
                className={item.active ? "walkthrough-item active" : "walkthrough-item"}
                key={item.title}
              >
                <span className="item-dot">{item.active ? "✓" : index + 1}</span>
                <div>
                  <strong>{item.title}</strong>
                  <em>{item.file}</em>
                </div>
                <span className="item-change">{item.changes}</span>
              </article>
            ))}
          </div>
          <div className="sidebar-total">
            <span>Total</span>
            <strong>+11 -0</strong>
          </div>
        </aside>

        <div className="real-content">
          <header className="real-topbar">
            <span>
              Opened PR #1847: feat: [AUR-4182] guided review queue for workspace snapshots
            </span>
          </header>

          <div className="real-canvas">
            <section className="real-focus-card">
              <div className="focus-card-top">
                <span className="critical-pill">Critical</span>
              </div>
              <h3>Snapshot restore now waits for branch metadata</h3>
              <p>
                Verify the workspace restores viewed files only after the branch identity has been
                resolved.
              </p>
            </section>

            <section className="real-pr-card">
              <div className="pr-badges">
                <span>#1847</span>
                <span className="open-badge">Open</span>
                <span>@riley-review</span>
              </div>
              <h3>feat: [AUR-4182] guided review queue for workspace snapshots</h3>
              <div className="pr-meta-grid">
                <span>
                  Files <strong>7</strong>
                </span>
                <span>
                  Commits <strong>3</strong>
                </span>
                <span>
                  Head <strong>7f4c1d2</strong>
                </span>
                <span>
                  Base <strong>2a91be8</strong>
                </span>
              </div>
            </section>

            <section className="real-diff-panel" aria-label="Split diff preview">
              <div className="diff-filebar">
                <span>apps/console/src/review/restoreSnapshot.ts</span>
                <div>
                  <span>+4 -1</span>
                  <span>Modified</span>
                  <span>Viewed</span>
                </div>
              </div>
              <div className="split-diff">
                {splitDiffRows.map((row) => (
                  <div className={`split-row ${row.tone}`} key={`${row.leftLine}-${row.rightLine}`}>
                    <span>{row.leftLine}</span>
                    <code>{row.left}</code>
                    <span>{row.rightLine}</span>
                    <code>{row.right}</code>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

function DiffDashMark() {
  return (
    <svg className="mark" viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="14" fill="#07111f" />
      <path d="M11 15c0-2.2 1.8-4 4-4h8v26h-8c-2.2 0-4-1.8-4-4V15Z" fill="#14f195" />
      <path d="M25 11h8c2.2 0 4 1.8 4 4v18c0 2.2-1.8 4-4 4h-8V11Z" fill="#ff5a6a" />
      <path d="M15 19h6M18 16v6M28 19h6" stroke="white" strokeLinecap="round" strokeWidth="2.4" />
      <path
        d="M15 28h7M27 28h7M16 33h5M29 33h5"
        stroke="white"
        strokeLinecap="round"
        strokeOpacity=".72"
        strokeWidth="2.4"
      />
    </svg>
  )
}
