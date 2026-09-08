// Canonical ordering for anything whose bytes are compared, hashed, or shipped: source
// manifests, digest inputs, archive entries and lockfile canonicalisation.
//
// `localeCompare` answers by the host's locale and ICU data, so the same tree can order
// differently on two machines and produce a different digest or a different archive byte
// order. Comparing code units is the same everywhere. This is deliberately not for
// human-facing lists, where locale order is the correct answer.
export const byCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export const byCodeUnitOn = (select) => (left, right) => byCodeUnit(select(left), select(right));
