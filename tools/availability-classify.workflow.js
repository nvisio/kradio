export const meta = {
  name: 'availability-classify',
  description: 'Classify featured stream availability (geo/event) with adversarial verification',
  phases: [
    { title: 'Classify', detail: 'one agent per candidate: global | geo_restricted | event_based' },
    { title: 'Verify', detail: 'adversarial refute pass on each non-global verdict' },
  ],
}

// args: [{ name, url, country, httpStatus, geoHint, signal }]
// returns: { verdicts: [{url, availability, countries?, type?, stationId?, reason}], review: [...] }

const CANDIDATES = Array.isArray(args) ? args : []

const CLASSIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['availability', 'confidence', 'reason'],
  properties: {
    availability: { enum: ['global', 'geo_restricted', 'event_based'] },
    countries: { type: 'array', items: { type: 'string' } },
    type: { enum: ['direct', 'radiko'] },
    stationId: { type: 'string' },
    confidence: { enum: ['low', 'medium', 'high'] },
    reason: { type: 'string' },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['stillRestricted', 'reason'],
  properties: { stillRestricted: { type: 'boolean' }, reason: { type: 'string' } },
}

function classifyPrompt(c) {
  return [
    `Audit whether a radio AUDIO stream is globally playable.`,
    `Station: ${JSON.stringify(c.name)}  URL: ${c.url}  Listed country: ${c.country}`,
    `Probe: httpStatus=${c.httpStatus ?? 'n/a'}, geoHint=${!!c.geoHint} (403/451), signal=${c.signal}`,
    ``,
    `Rules:`,
    `- DEFAULT to "global". Only geo_restricted/event_based with a STRONG signal.`,
    `- A 403/451 (geoHint) is a strong geo/auth signal.`,
    `- radiko.jp → geo_restricted, countries=["jp"], type="radiko", stationId if inferable.`,
    `- Public broadcasters (ARD/WDR/SWR/NDR/DLF, BBC radio, Radio France, RAI, RTVE)`,
    `  serve AUDIO worldwide; do NOT mark geo_restricted without a 403/451.`,
    `- event_based: live only during specific events (e.g. a Bundesliga Konferenz feed).`,
    `- countries = where it IS available (lowercase alpha-2).`,
  ].join('\n')
}
function refutePrompt(c, v) {
  return [
    `A reviewer marked this radio AUDIO stream "${v.availability}"${v.countries ? ` (in: ${v.countries.join(', ')})` : ''}.`,
    `Station: ${JSON.stringify(c.name)} URL: ${c.url} probe httpStatus=${c.httpStatus ?? 'n/a'} geoHint=${!!c.geoHint}.`,
    `Reason: ${v.reason}`,
    `Try to REFUTE the restriction. Public-broadcaster audio is usually global.`,
    `If the only evidence is a guess (no 403/451, not radiko), set stillRestricted=false.`,
    `Keep true ONLY if well-supported (403/451, radiko, or a genuine event-only feed).`,
    `When in doubt, refute (false).`,
  ].join('\n')
}

const results = await pipeline(
  CANDIDATES,
  (c) => agent(classifyPrompt(c), { label: `classify:${c.country}:${(c.name || '').slice(0, 20)}`, phase: 'Classify', schema: CLASSIFY_SCHEMA }).then((v) => ({ c, v })),
  ({ c, v }) => {
    if (!v || v.availability === 'global') return { c, v, restricted: false }
    return parallel([0, 1, 2].map((i) => () =>
      agent(refutePrompt(c, v), { label: `verify:${c.country}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA })
    )).then((votes) => {
      const kept = votes.filter(Boolean).filter((x) => x.stillRestricted).length
      const total = votes.filter(Boolean).length || 1
      return { c, v, restricted: kept * 2 > total }
    })
  }
)

const verdicts = [], review = []
for (const r of results.filter(Boolean)) {
  if (!r.v || r.v.availability === 'global') continue
  if (r.restricted && r.v.confidence !== 'low') {
    verdicts.push({ url: r.c.url, availability: r.v.availability, countries: r.v.countries || [r.c.country],
      ...(r.v.type ? { type: r.v.type } : {}), ...(r.v.stationId ? { stationId: r.v.stationId } : {}), reason: r.v.reason })
  } else {
    review.push({ url: r.c.url, name: r.c.name, country: r.c.country, proposed: r.v.availability,
      confidence: r.v.confidence, restrictedByPanel: r.restricted, reason: r.v.reason, httpStatus: r.c.httpStatus, geoHint: r.c.geoHint })
  }
}
log(`candidates=${CANDIDATES.length} verdicts=${verdicts.length} review=${review.length}`)
return { verdicts, review }
