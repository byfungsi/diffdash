const htmlEntities: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/** Escapes text for safe insertion into HTML text and quoted attribute contexts. */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (character) => htmlEntities[character] ?? character)
