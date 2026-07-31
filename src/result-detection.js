export function geminiImageIdentity(source) {
  const value = String(source || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value, "https://gemini.google.com/");
    return url.href;
  } catch {
    return value;
  }
}

export function selectNewImage(
  baselineSources,
  candidates,
  { baselineTurnIds = [] } = {},
) {
  const baseline = new Set(
    (baselineSources || []).map(geminiImageIdentity).filter(Boolean),
  );
  const oldTurns = new Set(baselineTurnIds || []);
  return candidates
    .map((candidate) => ({
      ...candidate,
      imageKey:
        candidate.imageKey || geminiImageIdentity(candidate.src),
    }))
    .filter(
      (candidate) =>
        candidate.src &&
        candidate.imageKey &&
        !baseline.has(candidate.imageKey) &&
        (!candidate.turnId || !oldTurns.has(candidate.turnId)),
    )
    .sort(
      (a, b) =>
        Number(b.turnIndex || 0) - Number(a.turnIndex || 0) ||
        imageArea(b) - imageArea(a),
    )[0] || null;
}

function imageArea(candidate) {
  return Math.max(0, candidate.width || 0) * Math.max(0, candidate.height || 0);
}
