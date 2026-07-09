import type { HazardCategory } from "@ledgerline/contracts";
import { normalize } from "./text.js";

/**
 * A group is a set of alternative phrases; the group matches if any of them
 * appears. A rule matches when *every* group matches, within `withinTokens` of
 * each other.
 *
 * Single-group rules are plain phrase lookups ("fuga de gas"). Multi-group
 * rules express co-occurrence — "smell" near "gas" — which survives the word
 * order of both English and Spanish without us writing out the cross product.
 */
export type PhraseGroup = readonly string[];

export interface HazardRule {
  readonly id: string;
  readonly category: HazardCategory;
  readonly groups: readonly PhraseGroup[];
  /** Max token span across all matched groups. Omit for "anywhere". */
  readonly withinTokens?: number;
  /**
   * Fires only when ambient temperature is at or below freezing. "No heat" in
   * July is a routine job; in a hard freeze it is a life-safety call.
   */
  readonly requiresFreezing?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Reusable groups                                                             */
/* -------------------------------------------------------------------------- */

const SMELL_VERBS: PhraseGroup = [
  "smell",
  "smells",
  "smelling",
  "stinks",
  "huele",
  "huelo",
  "oler",
  "olor",
];

const GAS_NOUNS: PhraseGroup = ["gas", "propane", "propano", "butano"];

const NO_HEAT: PhraseGroup = [
  "no heat",
  "without heat",
  "heat is out",
  "heater is dead",
  "heater is out",
  "furnace is out",
  "furnace is dead",
  "no calefaccion",
  "sin calefaccion",
  "no tengo calefaccion",
  "calefaccion no funciona",
  "no hay calefaccion",
];

const FREEZING_CUES: PhraseGroup = [
  "freezing",
  "below freezing",
  "below zero",
  "pipes are freezing",
  "ice",
  "congelando",
  "congelado",
  "helando",
  "bajo cero",
  "mucho frio",
];

const WATER_INTRUSION: PhraseGroup = [
  "flooding",
  "flooded",
  "flood",
  "water everywhere",
  "burst pipe",
  "pipe burst",
  "gushing water",
  "water pouring",
  "inundacion",
  "inundado",
  "inundando",
  "tuberia rota",
  "se revento la tuberia",
  "agua por todas partes",
];

const SEWAGE: PhraseGroup = [
  "sewage",
  "sewer backup",
  "raw sewage",
  "sewage backing up",
  "toilet overflowing",
  "aguas negras",
  "aguas residuales",
  "se desborda el inodoro",
];

const SMOKE: PhraseGroup = [
  "smoke",
  "smoky",
  "humo",
  "burning smell",
  "smells like burning",
  "huele a quemado",
];

/** People for whom an otherwise-routine hazard becomes life-safety. */
const VULNERABLE_PEOPLE: PhraseGroup = [
  "baby",
  "infant",
  "newborn",
  "toddler",
  "child",
  "children",
  "kid",
  "kids",
  "elderly",
  "grandmother",
  "grandma",
  "grandfather",
  "grandpa",
  "bebe",
  "nino",
  "nina",
  "ninos",
  "anciano",
  "anciana",
  "abuela",
  "abuelo",
  "adulto mayor",
];

/**
 * Hazards that are ordinarily a warm transfer, but escalate in category when a
 * vulnerable person is in the house. Composed from the groups above rather than
 * re-listed, so tuning `WATER_INTRUSION` tunes both places it is used.
 */
const ESCALATING_HAZARDS: PhraseGroup = [
  ...WATER_INTRUSION,
  ...SEWAGE,
  ...SMOKE,
  ...NO_HEAT,
];

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

export const HAZARD_RULES: readonly HazardRule[] = [
  // --- Gas -----------------------------------------------------------------
  {
    id: "gas.leak.phrase",
    category: "GAS_LEAK",
    groups: [
      [
        "gas leak",
        "leaking gas",
        "gas is leaking",
        "fuga de gas",
        "escape de gas",
        "olor a gas",
      ],
    ],
  },
  {
    id: "gas.smell.cooccurrence",
    category: "GAS_LEAK",
    groups: [SMELL_VERBS, GAS_NOUNS],
    withinTokens: 6,
  },
  {
    id: "gas.mercaptan",
    category: "GAS_LEAK",
    groups: [["rotten egg", "rotten eggs", "sulfur", "sulphur", "azufre"]],
  },

  // --- Carbon monoxide -----------------------------------------------------
  {
    id: "co.named",
    category: "CARBON_MONOXIDE",
    groups: [
      [
        "carbon monoxide",
        "monoxide",
        "monoxido de carbono",
        "monoxido",
        "co detector",
      ],
    ],
  },

  // --- Fire ----------------------------------------------------------------
  {
    id: "fire.active",
    category: "FIRE",
    groups: [
      [
        "on fire",
        "house fire",
        "there is a fire",
        "flames",
        "something is burning",
        "fuego",
        "incendio",
        "llamas",
        "se esta quemando",
      ],
    ],
  },
  {
    id: "fire.smoke",
    category: "FIRE",
    groups: [SMOKE, ["coming", "filling", "everywhere", "saliendo", "llenando"]],
    withinTokens: 5,
  },

  // --- Electrical ----------------------------------------------------------
  {
    id: "electrical.arc",
    category: "ELECTRICAL_ARC",
    groups: [
      [
        "sparking",
        "sparks",
        "arcing",
        "live wire",
        "exposed wire",
        "shocked me",
        "chispas",
        "chispeando",
        "cable pelado",
        "cable expuesto",
        "me dio corriente",
        "corto circuito",
        "cortocircuito",
      ],
    ],
  },

  // --- Water & sewage ------------------------------------------------------
  { id: "water.intrusion", category: "FLOODING", groups: [WATER_INTRUSION] },
  { id: "sewage.backup", category: "SEWAGE_BACKUP", groups: [SEWAGE] },

  // --- Cold ----------------------------------------------------------------
  {
    id: "cold.no_heat_lexical",
    category: "NO_HEAT_FREEZING",
    groups: [NO_HEAT, FREEZING_CUES],
    withinTokens: 14,
  },
  {
    // The caller need not say "freezing" if we already know it is. Requires the
    // runtime to supply the tenant's local temperature.
    id: "cold.no_heat_ambient",
    category: "NO_HEAT_FREEZING",
    groups: [NO_HEAT],
    requiresFreezing: true,
  },

  // --- Vulnerable person ---------------------------------------------------
  {
    id: "vulnerable.person_with_hazard",
    category: "VULNERABLE_PERSON_AT_RISK",
    groups: [VULNERABLE_PEOPLE, ESCALATING_HAZARDS],
    withinTokens: 25,
  },
];

/**
 * Severity ordering. When several rules fire on one utterance we act on the
 * most dangerous: a gas leak in a house with a baby is a gas leak, and the
 * caller gets 911 guidance, not a warm transfer.
 */
export const HAZARD_SEVERITY: Readonly<Record<HazardCategory, number>> = {
  GAS_LEAK: 100,
  CARBON_MONOXIDE: 100,
  FIRE: 95,
  ELECTRICAL_ARC: 90,
  VULNERABLE_PERSON_AT_RISK: 60,
  FLOODING: 50,
  NO_HEAT_FREEZING: 45,
  SEWAGE_BACKUP: 40,
};

/** Temperature at or below which `requiresFreezing` rules arm themselves. */
export const FREEZING_POINT_F = 32;

/** Phrases are compiled to token arrays once, at module load. */
export interface CompiledRule extends Omit<HazardRule, "groups"> {
  readonly groups: readonly (readonly (readonly string[])[])[];
}

export const COMPILED_RULES: readonly CompiledRule[] = HAZARD_RULES.map((rule) => ({
  ...rule,
  groups: rule.groups.map((group) =>
    group.map((phrase) => phrase.split(/\s+/).map(normalize)),
  ),
}));
