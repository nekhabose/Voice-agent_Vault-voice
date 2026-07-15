/**
 * Which consent law governs recording this call.
 *
 * `plan.md` Step 8: "two-party-consent recording by state, keyed off the caller's
 * area code with a conservative default." The conservative default is not a
 * fallback here. It is the load-bearing part, and the map exists to earn the
 * *exceptions* to it — see {@link ALL_PARTY_CONSENT_STATES} and
 * {@link AREA_CODE_STATE}.
 *
 * ## The map is allowed to be wrong in exactly one direction
 *
 * An area code is **evidence of where a caller is, not a fact about it.** Number
 * portability and mobile phones mean a `+1 415` number can be standing in a
 * Boston kitchen, and nothing in the signalling tells us. So every verdict this
 * file reaches is a belief, and the design question is which way the beliefs are
 * allowed to be wrong.
 *
 * They are allowed to be wrong toward *more* caution and never toward less:
 *
 * - An area code we do not know → `UNKNOWN` → treated as all-party. So an
 *   **incomplete map is safe**, and every new NANP area code we have never heard
 *   of is safe on the day it is assigned, with no deploy.
 * - An area code wrongly listed under an all-party state → still all-party. Costs
 *   us a recording we could lawfully have made. Nobody is harmed.
 * - An area code wrongly listed under a **one-party** state is the one mistake
 *   that matters: it would record a caller who is, in law, entitled to be asked
 *   first.
 *
 * Which is why the one-party half of {@link AREA_CODE_STATE} lists only codes we
 * are confident about and omits the rest, while the all-party half is deliberately
 * generous. A missing code is a recording we did not make; a wrong one is a
 * recording we were not allowed to make.
 *
 * ## And the tenant is a party too
 *
 * Two people are on the call. Courts apply the stricter of the two states' laws,
 * so the regime is all-party if **either** end is all-party — and the contractor's
 * end, unlike the caller's, is a fixed address we actually know
 * ({@link TenantConsentProfile.stateCode}). `ONE_PARTY` is therefore reached only
 * when *both* ends are known one-party states: a claim we can defend, rather than
 * one we merely have no evidence against.
 */

/** The three verdicts. `UNKNOWN` is not an error; it is the honest one. */
export type ConsentRegime = "ALL_PARTY" | "ONE_PARTY" | "UNKNOWN";

/** What the compliance rules need to know about the contractor. */
export interface TenantConsentProfile {
  /** USPS code of the contractor's own state. Anything unrecognised is `UNKNOWN`. */
  readonly stateCode: string;
}

/**
 * States where every party to a call must consent before it may be recorded.
 *
 * Four of these are contested, and all four are listed here on purpose:
 *
 * - **Michigan** — the eavesdropping statute reads as all-party, and appellate
 *   courts have read it as one-party for a *participant*. Unsettled.
 * - **Nevada** — one-party by the plain text; the Nevada Supreme Court read the
 *   telephone provision as all-party (*Lane v. Allstate*).
 * - **Oregon** — all-party for in-person conversations, one-party for telephone.
 * - **Connecticut** — one-party under the criminal statute, all-party under the
 *   civil recording statute, which is the one that creates a private right of
 *   action against us.
 *
 * A state whose law is *argued about* is a state we do not litigate in. Listing it
 * strictly costs us the pre-notice seconds of a call. Listing it loosely costs a
 * contractor a lawsuit, in a product whose entire pitch is that we tell the truth
 * about our failures.
 */
export const ALL_PARTY_CONSENT_STATES = [
  "CA",
  "CT",
  "DE",
  "FL",
  "IL",
  "MD",
  "MA",
  "MI",
  "MT",
  "NV",
  "NH",
  "OR",
  "PA",
  "WA",
] as const;

const ALL_PARTY = new Set<string>(ALL_PARTY_CONSENT_STATES);

/**
 * NANP area code → USPS state.
 *
 * Not a complete NANP table, and it does not try to be: Canada, the Caribbean, the
 * US territories, toll-free, and every code assigned after this was written all fall
 * through to `UNKNOWN`, which is the strict branch. Completeness would buy us nothing
 * but recordings; correctness in the one-party half is what buys us safety.
 */
export const AREA_CODE_STATE: Readonly<Record<string, string>> = {
  /* ---- all-party states: generous, because over-inclusion is free ---- */

  // California
  "209": "CA", "213": "CA", "279": "CA", "310": "CA", "323": "CA", "341": "CA",
  "350": "CA", "408": "CA", "415": "CA", "424": "CA", "442": "CA", "510": "CA",
  "530": "CA", "559": "CA", "562": "CA", "619": "CA", "626": "CA", "628": "CA",
  "650": "CA", "657": "CA", "661": "CA", "669": "CA", "707": "CA", "714": "CA",
  "747": "CA", "760": "CA", "805": "CA", "818": "CA", "820": "CA", "831": "CA",
  "840": "CA", "858": "CA", "909": "CA", "916": "CA", "925": "CA", "949": "CA",
  "951": "CA",
  // Connecticut
  "203": "CT", "475": "CT", "860": "CT", "959": "CT",
  // Delaware
  "302": "DE",
  // Florida
  "239": "FL", "305": "FL", "321": "FL", "352": "FL", "386": "FL", "407": "FL",
  "448": "FL", "561": "FL", "656": "FL", "689": "FL", "727": "FL", "754": "FL",
  "772": "FL", "786": "FL", "813": "FL", "850": "FL", "863": "FL", "904": "FL",
  "941": "FL", "954": "FL",
  // Illinois
  "217": "IL", "224": "IL", "309": "IL", "312": "IL", "331": "IL", "447": "IL",
  "464": "IL", "618": "IL", "630": "IL", "708": "IL", "730": "IL", "773": "IL",
  "779": "IL", "815": "IL", "847": "IL", "872": "IL",
  // Maryland
  "227": "MD", "240": "MD", "301": "MD", "410": "MD", "443": "MD", "667": "MD",
  // Massachusetts
  "339": "MA", "351": "MA", "413": "MA", "508": "MA", "617": "MA", "774": "MA",
  "781": "MA", "857": "MA", "978": "MA",
  // Michigan
  "231": "MI", "248": "MI", "269": "MI", "313": "MI", "517": "MI", "586": "MI",
  "616": "MI", "679": "MI", "734": "MI", "810": "MI", "906": "MI", "947": "MI",
  "989": "MI",
  // Montana
  "406": "MT",
  // Nevada
  "702": "NV", "725": "NV", "775": "NV",
  // New Hampshire
  "603": "NH",
  // Oregon
  "458": "OR", "503": "OR", "541": "OR", "971": "OR",
  // Pennsylvania
  "215": "PA", "223": "PA", "267": "PA", "272": "PA", "412": "PA", "445": "PA",
  "484": "PA", "570": "PA", "582": "PA", "610": "PA", "717": "PA", "724": "PA",
  "814": "PA", "835": "PA", "878": "PA",
  // Washington
  "206": "WA", "253": "WA", "360": "WA", "425": "WA", "509": "WA", "564": "WA",

  /* ---- one-party states: only codes we are sure of. A wrong entry here is the
     one wrong entry that records somebody who was entitled to be asked first. ---- */

  "205": "AL", "251": "AL", "256": "AL", "334": "AL",
  "907": "AK",
  "480": "AZ", "520": "AZ", "602": "AZ", "623": "AZ", "928": "AZ",
  "479": "AR", "501": "AR", "870": "AR",
  "303": "CO", "719": "CO", "720": "CO", "970": "CO",
  "202": "DC",
  "229": "GA", "404": "GA", "470": "GA", "478": "GA", "678": "GA", "706": "GA",
  "762": "GA", "770": "GA", "912": "GA",
  "808": "HI",
  "208": "ID",
  "219": "IN", "260": "IN", "317": "IN", "574": "IN", "765": "IN", "812": "IN",
  "319": "IA", "515": "IA", "563": "IA", "641": "IA", "712": "IA",
  "316": "KS", "620": "KS", "785": "KS", "913": "KS",
  "270": "KY", "502": "KY", "606": "KY", "859": "KY",
  "225": "LA", "318": "LA", "337": "LA", "504": "LA", "985": "LA",
  "207": "ME",
  "218": "MN", "320": "MN", "507": "MN", "612": "MN", "651": "MN", "763": "MN",
  "952": "MN",
  "228": "MS", "601": "MS", "662": "MS",
  "314": "MO", "417": "MO", "573": "MO", "636": "MO", "660": "MO", "816": "MO",
  "308": "NE", "402": "NE",
  "201": "NJ", "551": "NJ", "609": "NJ", "732": "NJ", "856": "NJ", "908": "NJ",
  "973": "NJ",
  "505": "NM", "575": "NM",
  "212": "NY", "315": "NY", "332": "NY", "347": "NY", "516": "NY", "518": "NY",
  "585": "NY", "607": "NY", "631": "NY", "646": "NY", "716": "NY", "718": "NY",
  "845": "NY", "914": "NY", "917": "NY", "929": "NY",
  "252": "NC", "336": "NC", "704": "NC", "828": "NC", "910": "NC", "919": "NC",
  "980": "NC",
  "701": "ND",
  "216": "OH", "234": "OH", "330": "OH", "419": "OH", "440": "OH", "513": "OH",
  "567": "OH", "614": "OH", "740": "OH", "937": "OH",
  "405": "OK", "539": "OK", "580": "OK", "918": "OK",
  "401": "RI",
  "803": "SC", "843": "SC", "864": "SC",
  "605": "SD",
  "423": "TN", "615": "TN", "731": "TN", "865": "TN", "901": "TN", "931": "TN",
  "210": "TX", "214": "TX", "254": "TX", "281": "TX", "325": "TX", "346": "TX",
  "361": "TX", "409": "TX", "430": "TX", "432": "TX", "469": "TX", "512": "TX",
  "682": "TX", "713": "TX", "737": "TX", "806": "TX", "817": "TX", "830": "TX",
  "832": "TX", "903": "TX", "915": "TX", "936": "TX", "940": "TX", "956": "TX",
  "972": "TX", "979": "TX",
  "385": "UT", "435": "UT", "801": "UT",
  // Vermont (802) is deliberately absent: it has no wiretapping statute at all, and
  // its Supreme Court has read a privacy interest into the vacuum. "No statute" is
  // not "one-party" — it is `UNKNOWN`, which is the strict branch, which is where a
  // state whose law nobody can quote belongs.
  "276": "VA", "434": "VA", "540": "VA", "571": "VA", "703": "VA", "757": "VA",
  "804": "VA",
  "304": "WV",
  "262": "WI", "414": "WI", "608": "WI", "715": "WI", "920": "WI",
  "307": "WY",
};

/**
 * The area code of a US number, or `null` for anything we cannot read as one.
 *
 * `null` covers a caller who withheld their number, a non-`+1` country, a short
 * code, and a `+1` number whose area code is not a valid NPA (it may not start with
 * `0` or `1`). Every one of those lands in `UNKNOWN`, and `UNKNOWN` is strict.
 */
export function areaCodeOf(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const match = /^\+1([2-9]\d{2})\d{7}$/.exec(e164.trim());
  return match?.[1] ?? null;
}

/** Where the caller's *number* was issued. Not where the caller is. */
export function stateForNumber(e164: string | null | undefined): string | null {
  const npa = areaCodeOf(e164);
  if (npa === null) return null;
  return AREA_CODE_STATE[npa] ?? null;
}

/** One party's regime. An unrecognised or absent state is `UNKNOWN`, never `ONE_PARTY`. */
export function regimeForState(stateCode: string | null | undefined): ConsentRegime {
  if (!stateCode) return "UNKNOWN";
  const code = stateCode.trim().toUpperCase();
  if (ALL_PARTY.has(code)) return "ALL_PARTY";
  return KNOWN_ONE_PARTY.has(code) ? "ONE_PARTY" : "UNKNOWN";
}

/**
 * Every state named in {@link AREA_CODE_STATE} that is not all-party.
 *
 * Derived rather than restated. A hand-kept second list is a list that will one day
 * disagree with the first, and the disagreement would be a state we record in
 * because two arrays drifted.
 */
const KNOWN_ONE_PARTY = new Set<string>(
  Object.values(AREA_CODE_STATE).filter((state) => !ALL_PARTY.has(state)),
);

export interface ConsentAssessment {
  readonly regime: ConsentRegime;
  /** Where the caller's number was issued. `null` means we could not tell. */
  readonly callerState: string | null;
  readonly tenantState: string;
  /** One sentence, kept with the call. A verdict with no argument is not auditable. */
  readonly reason: string;
}

/**
 * The stricter of the two parties' laws — which is what a court would apply.
 *
 * `ONE_PARTY` requires *both* ends to be known one-party states. Either end
 * all-party, or either end unknown, and the answer is all-party. There is no branch
 * in which ignorance is permissive.
 */
export function assessConsent(
  callerE164: string | null | undefined,
  tenant: TenantConsentProfile,
): ConsentAssessment {
  const callerState = stateForNumber(callerE164);
  const tenantState = tenant.stateCode.trim().toUpperCase();

  const caller = regimeForState(callerState);
  const contractor = regimeForState(tenantState);

  if (caller === "ALL_PARTY" || contractor === "ALL_PARTY") {
    const which =
      caller === "ALL_PARTY" ? `the caller's ${callerState}` : `the contractor's ${tenantState}`;
    return {
      regime: "ALL_PARTY",
      callerState,
      tenantState,
      reason: `${which} requires every party to consent before a call may be recorded`,
    };
  }

  if (caller === "ONE_PARTY" && contractor === "ONE_PARTY") {
    return {
      regime: "ONE_PARTY",
      callerState,
      tenantState,
      reason: `both ends (${callerState}, ${tenantState}) are one-party-consent states`,
    };
  }

  return {
    regime: "UNKNOWN",
    callerState,
    tenantState,
    reason:
      callerState === null
        ? "the caller's number tells us nothing about where they are; assuming all-party"
        : `we do not know ${caller === "UNKNOWN" ? callerState : tenantState}'s recording law; assuming all-party`,
  };
}

/** `UNKNOWN` and `ALL_PARTY` are the same rule. Only `ONE_PARTY` is an exception. */
export function requiresNoticeBeforeRecording(regime: ConsentRegime): boolean {
  return regime !== "ONE_PARTY";
}
