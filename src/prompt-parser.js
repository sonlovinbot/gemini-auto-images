/**
 * A blank line separates multi-line prompts. If there is no blank line,
 * every non-empty line is one prompt. This mirrors the import behaviour users
 * already know from the reference Flow extension.
 */
export function parsePrompts(value) {
  const input = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!input) return [];
  const separator = /\n[ \t]*\n/.test(input) ? /\n[ \t]*\n+/ : /\n+/;
  return input
    .split(separator)
    .map((prompt) => prompt.trim())
    .filter(Boolean);
}

export function buildOutputName(prefix, index, total) {
  const cleaned = String(prefix || "gemini-image")
    .trim()
    .replace(/[\\/:"*?<>|]+/g, "-")
    .replace(/\.(png|jpe?g|webp)$/i, "") || "gemini-image";
  const digits = Math.max(3, String(Math.max(1, total)).length);
  return `${cleaned}-${String(index + 1).padStart(digits, "0")}.png`;
}

export function assignReferences(references, promptIndex, mode = "shared") {
  const ordered = Array.from(references || []);
  if (mode === "matched") {
    return ordered[promptIndex] ? [ordered[promptIndex]] : [];
  }
  return ordered;
}
