/** Builds a self-contained fallback page that does not depend on React, preload, or IPC. */
export const electronErrorPageDataUrl = (message: string, reloadUrl: string) => {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>DiffDash error</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { box-sizing: border-box; width: min(36rem, calc(100% - 3rem)); padding: 1.5rem; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 0.75rem; }
    small { opacity: 0.65; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    h1 { margin: 0.5rem 0 0; font-size: 1.25rem; }
    p { margin: 0.75rem 0 0; opacity: 0.75; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    a { display: inline-flex; margin-top: 1.25rem; padding: 0.55rem 0.9rem; border-radius: 0.4rem; background: CanvasText; color: Canvas; font-size: 0.875rem; font-weight: 650; text-decoration: none; }
  </style>
</head>
<body>
  <main role="alert">
    <small>DiffDash beta</small>
    <h1>DiffDash encountered an error</h1>
    <p>${escapeHtml(message)}</p>
    <a href="${escapeHtml(reloadUrl)}">Reload DiffDash</a>
  </main>
</body>
</html>`
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
