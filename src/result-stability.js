export function candidateFingerprint(candidate) {
  if (!candidate) return "";
  return [
    candidate.imageKey || candidate.src || "",
    candidate.turnId || "",
    Number(candidate.width) || 0,
    Number(candidate.height) || 0,
  ].join("|");
}

export function advanceCandidateStability(
  previous,
  scan,
  { activeRequired = 5, idleRequired = 2 } = {},
) {
  const required = scan.generating ? activeRequired : idleRequired;
  const key = scan.candidate?.ready
    ? candidateFingerprint(scan.candidate)
    : "";
  const count = key
    ? key === previous.key
      ? previous.count + 1
      : 1
    : 0;

  return {
    key,
    count,
    required,
    candidate: count >= required ? scan.candidate : null,
  };
}

export function scanFingerprint(scan) {
  const candidate = scan.candidate;
  return [
    Number(scan.turnCount) || 0,
    Number(scan.candidateCount) || 0,
    Boolean(scan.generating),
    candidateFingerprint(candidate),
    Boolean(candidate?.ready),
  ].join("|");
}

export function advanceScanStagnation(previous, scan) {
  const fingerprint = scanFingerprint(scan);
  return {
    fingerprint,
    count:
      fingerprint === previous.fingerprint
        ? previous.count + 1
        : 1,
  };
}
