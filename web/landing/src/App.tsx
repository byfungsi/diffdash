const fileItems = [
  "src/review-workspace.ts",
  "src/services/github.ts",
  "src/ui/diff-viewer.tsx",
  "tests/review.test.ts",
]

const diffRows = [
  { tone: "added", code: "+ persist viewed files by branch" },
  { tone: "neutral", code: "  const request = parseReview(input)" },
  { tone: "removed", code: "- clear state when changing files" },
  { tone: "added", code: "+ restore walkthrough checkpoints" },
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
            <span /> Private beta for macOS review teams
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
      <div className="app-window">
        <div className="window-topbar">
          <div className="window-controls">
            <span />
            <span />
            <span />
          </div>
          <div className="branch-pill">github.com/acme/platform · PR #482</div>
        </div>
        <div className="workspace-grid">
          <aside className="file-list" aria-label="Changed files preview">
            <p>Changed files</p>
            {fileItems.map((file, index) => (
              <span className={index === 0 ? "active" : undefined} key={file}>
                {file}
              </span>
            ))}
          </aside>
          <section className="diff-card" aria-label="Diff preview">
            <div className="diff-card-header">
              <span>review-workspace.ts</span>
              <strong>4 hunks</strong>
            </div>
            {diffRows.map((row) => (
              <code className={`diff-line ${row.tone}`} key={row.code}>
                {row.code}
              </code>
            ))}
          </section>
          <aside className="assistant-note" aria-label="AI walkthrough preview">
            <span>Walkthrough</span>
            <p>
              The persistence change is safe if branch IDs stay stable between refreshes. Check the
              fallback for detached HEAD reviews.
            </p>
          </aside>
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
