import type { MouseEvent } from "react"
import { useRef, useState } from "react"
import { useGSAP } from "@gsap/react"
import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import productHomeScreenshot from "../../../product_ss_1.png"
import productReviewScreenshot from "../../../product_ss_2.png"
import {
  captureDownloadClick,
  captureNavClick,
  type DownloadPlacement,
  type DownloadPlatform,
  isAnalyticsEnabled,
} from "./analytics"

gsap.registerPlugin(ScrollTrigger, useGSAP)

const downloadUrls = {
  linuxAppImage: "https://download.usediffdash.com/linux/appimage",
  linuxDeb: "https://download.usediffdash.com/linux",
  macos: "https://download.usediffdash.com/macos",
}

const bentoCards = [
  {
    title: "One queue for every changed file",
    text: "Open a PR or local repo, then move through files with progress that survives refreshes.",
    className: "bento-card bento-large bento-product",
    visual: (
      <ScreenshotFrame
        src={productHomeScreenshot}
        alt="DiffDash repository review workspace"
        variant="home"
      />
    ),
  },
  {
    title: "Agent walkthroughs that point somewhere",
    text: "Use generated notes as a review map, not a noisy summary of every line.",
    className: "bento-card bento-tall bento-photo",
    visual: (
      <ScreenshotFrame
        src={productReviewScreenshot}
        alt="DiffDash review workspace showing walkthrough scope and split diff"
      />
    ),
  },
  {
    title: "Local review state",
    text: "Repository paths and progress stay on your machine while GitHub remains the source of truth.",
    className: "bento-card bento-tall bento-local",
    visual: <LocalLoop />,
  },
  {
    title: "CLI entry, desktop focus",
    text: "Run `diffdash .` and land in the desktop review workspace for the current repository.",
    className: "bento-card bento-large bento-terminal",
    visual: <TerminalPreview />,
  },
]

const stackCards = [
  {
    title: "The browser tab is not your review memory.",
    text: "DiffDash treats review progress as durable workspace state, so context is available when the review stretches across sessions.",
  },
  {
    title: "The walkthrough is a map, not the destination.",
    text: "Agent notes help you decide where to spend attention. The final judgment still happens in the diff.",
  },
  {
    title: "The local repo remains the center.",
    text: "The desktop app opens on real repositories and GitHub PRs without asking you to move source into a hosted mirror.",
  },
]

const testimonialQuotes = [
  {
    quote: "DiffDash makes large pull requests feel finite again.",
    name: "Nadia Verma",
    role: "Staff engineer",
  },
  {
    quote: "The agent summary helps, but the local review memory is the real win.",
    name: "Mateo Rivas",
    role: "Product engineer",
  },
]

function trackDownloadClick(
  event: MouseEvent<HTMLAnchorElement>,
  platform: DownloadPlatform,
  placement: DownloadPlacement,
) {
  const href = event.currentTarget.href
  captureDownloadClick(platform, placement, href)

  if (!isAnalyticsEnabled() || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return
  }

  event.preventDefault()
  window.setTimeout(() => {
    window.location.href = href
  }, 150)
}

/** Promotional landing page for DiffDash. */
export function App() {
  const [isLinuxDownloadsOpen, setIsLinuxDownloadsOpen] = useState(false)
  const linuxDownloadButtonRef = useRef<HTMLButtonElement>(null)

  function openLinuxDownloads(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    setIsLinuxDownloadsOpen(true)

    window.requestAnimationFrame(() => {
      linuxDownloadButtonRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      })
      linuxDownloadButtonRef.current?.focus({ preventScroll: true })
    })
  }

  return (
    <main className="landing-page overflow-x-hidden w-full max-w-full">
      <Navigation />

      <section className="hero" id="top">
        <div className="hero-bg" aria-hidden="true">
          <img src={productReviewScreenshot} alt="" />
        </div>
        <div className="hero-content">
          <h1>
            Review code <span className="inline-image inline-image-code" aria-hidden="true" />{" "}
            without losing the thread.
          </h1>
          <p>
            DiffDash is a desktop workspace for GitHub PRs, local diffs, and agent walkthroughs that
            keeps review progress on your machine.
          </p>
          <div className="hero-actions">
            <a
              className="button button-primary"
              href={downloadUrls.macos}
              onClick={(event) => trackDownloadClick(event, "macos", "hero")}
            >
              Download macOS
            </a>
            <a className="button button-secondary" href="#download" onClick={openLinuxDownloads}>
              Download Linux
            </a>
          </div>
        </div>
      </section>

      <section className="bento-section" id="workflow">
        <div className="section-heading centered-heading">
          <h2>Review work, arranged for attention.</h2>
          <p>Four surfaces, two dense rows, no dead grid cells. Each piece earns its space.</p>
        </div>
        <div className="bento-grid">
          {bentoCards.map((card) => (
            <article className={card.className} key={card.title}>
              <div className="bento-visual">{card.visual}</div>
              <div className="bento-copy">
                <h3>{card.title}</h3>
                <p>{card.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <ScrubText />

      <StackSection />

      <section className="testimonial-section">
        <div className="portrait-cluster" aria-hidden="true">
          <span className="portrait portrait-a" />
          <span className="portrait portrait-b" />
          <span className="portrait portrait-c" />
        </div>
        <div className="testimonial-copy">
          {testimonialQuotes.map((item) => (
            <figure key={item.name}>
              <blockquote>{item.quote}</blockquote>
              <figcaption>
                {item.name}, {item.role}
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="download-panel" id="download">
        <h2>Bring DiffDash into your next review.</h2>
        <p>
          Choose the build for your machine. Linux downloads include a portable AppImage and a
          Debian/Ubuntu package.
        </p>
        <div className="hero-actions centered-actions">
          <a
            className="button button-primary"
            href={downloadUrls.macos}
            onClick={(event) => trackDownloadClick(event, "macos", "footer")}
          >
            Download Mac OS
          </a>
          <button
            aria-controls="linux-download-options"
            aria-expanded={isLinuxDownloadsOpen}
            className={`button button-secondary ${isLinuxDownloadsOpen ? "is-active" : ""}`}
            onClick={() => setIsLinuxDownloadsOpen((isOpen) => !isOpen)}
            ref={linuxDownloadButtonRef}
            type="button"
          >
            Download Linux
          </button>
        </div>
        {isLinuxDownloadsOpen ? (
          <div className="linux-download-options" id="linux-download-options">
            <p>Choose a portable AppImage or a Debian/Ubuntu package.</p>
            <div className="linux-download-actions">
              <a
                className="button button-primary"
                href={downloadUrls.linuxAppImage}
                onClick={(event) => trackDownloadClick(event, "linux_appimage", "footer")}
              >
                Download AppImage
              </a>
              <a
                className="button button-secondary"
                href={downloadUrls.linuxDeb}
                onClick={(event) => trackDownloadClick(event, "linux_deb", "footer")}
              >
                Download Debian/Ubuntu
              </a>
            </div>
          </div>
        ) : null}
      </section>

      <footer className="site-footer">
        <span>DiffDash keeps review context local.</span>
        <nav aria-label="Footer navigation">
          <a href="#workflow">Workflow</a>
          <a href="#local-first">Local-first</a>
          <a href="#download">Download</a>
        </nav>
      </footer>
    </main>
  )
}

function Navigation() {
  return (
    <header className="site-nav">
      <a className="brand" href="#top" aria-label="DiffDash home">
        <DiffDashMark />
        <span>DiffDash</span>
      </a>
      <nav className="nav-links" aria-label="Primary navigation">
        <a href="#workflow" onClick={() => captureNavClick("workflow")}>
          Workflow
        </a>
        <a href="#local-first" onClick={() => captureNavClick("local-first")}>
          Local-first
        </a>
        <a href="#download" onClick={() => captureNavClick("download")}>
          Download
        </a>
      </nav>
    </header>
  )
}

function ScreenshotFrame({
  src,
  alt,
  variant = "review",
}: {
  readonly src: string
  readonly alt: string
  readonly variant?: "review" | "home"
}) {
  return (
    <div className={`screenshot-frame screenshot-frame-${variant}`}>
      <img src={src} alt={alt} loading="lazy" decoding="async" />
    </div>
  )
}

function ScrubText() {
  const sectionRef = useRef<HTMLElement>(null)
  const words =
    "A good review is not a faster skim. It is a controlled return to context, intent, and the exact files that still need judgment.".split(
      " ",
    )

  useGSAP(
    () => {
      if (!sectionRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        return

      const wordEls = gsap.utils.toArray<HTMLElement>(".scrub-word")
      gsap.fromTo(
        wordEls,
        { opacity: 0.16, y: 16 },
        {
          opacity: 1,
          y: 0,
          stagger: 0.08,
          ease: "none",
          scrollTrigger: {
            trigger: sectionRef.current,
            start: "top 70%",
            end: "bottom 35%",
            scrub: 1,
          },
        },
      )
    },
    { scope: sectionRef },
  )

  return (
    <section className="scrub-section" ref={sectionRef}>
      <p>
        {words.map((word, index) => (
          <span className="scrub-word" key={`${word}-${index}`}>
            {word}
          </span>
        ))}
      </p>
    </section>
  )
}

function StackSection() {
  const sectionRef = useRef<HTMLElement>(null)

  useGSAP(
    () => {
      if (!sectionRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        return

      const cards = gsap.utils.toArray<HTMLElement>(".stack-card")
      cards.forEach((card, index) => {
        gsap.fromTo(
          card,
          { scale: 0.9, opacity: 0.62, y: 80 },
          {
            scale: 1,
            opacity: 1,
            y: 0,
            ease: "none",
            scrollTrigger: {
              trigger: card,
              start: "top 82%",
              end: "top 38%",
              scrub: 1,
            },
          },
        )

        if (index < cards.length - 1) {
          gsap.to(card, {
            scale: 0.94,
            opacity: 0.42,
            ease: "none",
            scrollTrigger: {
              trigger: cards[index + 1],
              start: "top 74%",
              end: "top 32%",
              scrub: true,
            },
          })
        }
      })
    },
    { scope: sectionRef },
  )

  return (
    <section className="stack-section" id="local-first" ref={sectionRef}>
      <div className="stack-heading">
        <h2>Context should stack, not scatter.</h2>
        <p>Each review layer stays readable as the next one arrives.</p>
      </div>
      <div className="stack-track">
        {stackCards.map((card) => (
          <article className="stack-card" key={card.title}>
            <h3>{card.title}</h3>
            <p>{card.text}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function TerminalPreview() {
  return (
    <pre className="terminal-preview" aria-label="DiffDash command line preview">
      <code>
        <span>$ diffdash .</span>
        <span>Opening current repository</span>
        <span>Restoring review workspace</span>
        <span>Ready</span>
      </code>
    </pre>
  )
}

function LocalLoop() {
  return (
    <div className="local-loop" aria-hidden="true">
      <span>Repo</span>
      <span>DiffDash</span>
      <span>Review state</span>
    </div>
  )
}

function DiffDashMark() {
  return (
    <svg className="mark" viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="14" fill="#07111f" />
      <path d="M11 15c0-2.2 1.8-4 4-4h8v26h-8c-2.2 0-4-1.8-4-4V15Z" fill="#22c983" />
      <path d="M25 11h8c2.2 0 4 1.8 4 4v18c0 2.2-1.8 4-4 4h-8V11Z" fill="#f36d72" />
      <path d="M15 19h6M18 16v6M28 19h6" stroke="#f8fafc" strokeLinecap="round" strokeWidth="2.4" />
      <path
        d="M15 28h7M27 28h7M16 33h5M29 33h5"
        stroke="#f8fafc"
        strokeLinecap="round"
        strokeOpacity=".72"
        strokeWidth="2.4"
      />
    </svg>
  )
}
