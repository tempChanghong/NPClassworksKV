// A future timestamp cannot prove that an observation was received recently.
export function recentObservation(stamp, now = Date.now(), ttlMs = 15000) {
  const age = now - Date.parse(stamp);
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}
