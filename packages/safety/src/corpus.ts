import type { HazardCategory } from "@ledgerline/contracts";
import type { ClassifierContext } from "./classifier.js";

/**
 * The labeled corpus behind the classifier's published precision and recall
 * (plan, Verification §1). Every release reports these numbers.
 *
 * Bilingual by construction, including code-switched utterances, because
 * "Hola, uh, my water heater está leaking" is the normal case for this wedge,
 * not the edge case.
 */
export interface HazardSample {
  readonly text: string;
  readonly expected: HazardCategory;
  readonly context?: ClassifierContext;
}

export interface SafeSample {
  readonly text: string;
  readonly context?: ClassifierContext;
}

export const HAZARD_SAMPLES: readonly HazardSample[] = [
  // --- Gas -----------------------------------------------------------------
  { text: "I think there's a gas leak in the kitchen", expected: "GAS_LEAK" },
  { text: "It smells like gas in here", expected: "GAS_LEAK" },
  { text: "I smell propane near the tank", expected: "GAS_LEAK" },
  { text: "The whole house smells like rotten eggs", expected: "GAS_LEAK" },
  { text: "Huele a gas en la cocina", expected: "GAS_LEAK" },
  { text: "Hay una fuga de gas", expected: "GAS_LEAK" },
  { text: "Creo que hay un escape de gas", expected: "GAS_LEAK" },
  // Code-switched, the normal case for this wedge.
  { text: "Hola, huele a gas in the kitchen", expected: "GAS_LEAK" },
  // ASR routinely renders "leak" as "leek"; the in-phrase fuzz catches it.
  { text: "There's a gas leek behind the stove", expected: "GAS_LEAK" },

  // --- Carbon monoxide -----------------------------------------------------
  { text: "The carbon monoxide detector is going off", expected: "CARBON_MONOXIDE" },
  { text: "My CO detector won't stop beeping", expected: "CARBON_MONOXIDE" },
  { text: "El detector de monóxido de carbono está sonando", expected: "CARBON_MONOXIDE" },

  // --- Fire ----------------------------------------------------------------
  { text: "The water heater is on fire", expected: "FIRE" },
  { text: "There are flames coming from the furnace", expected: "FIRE" },
  { text: "Smoke is coming from the vents", expected: "FIRE" },
  { text: "Hay un incendio en el sótano", expected: "FIRE" },
  { text: "Se está quemando algo", expected: "FIRE" },

  // --- Electrical ----------------------------------------------------------
  { text: "The breaker panel is sparking", expected: "ELECTRICAL_ARC" },
  { text: "There's an exposed wire in the wall", expected: "ELECTRICAL_ARC" },
  { text: "The outlet shocked me", expected: "ELECTRICAL_ARC" },
  { text: "Hay chispas en el panel eléctrico", expected: "ELECTRICAL_ARC" },
  { text: "Me dio corriente cuando toqué el interruptor", expected: "ELECTRICAL_ARC" },

  // --- Water ---------------------------------------------------------------
  { text: "My basement is flooding", expected: "FLOODING" },
  { text: "A pipe burst and there's water everywhere", expected: "FLOODING" },
  { text: "El sótano se está inundando", expected: "FLOODING" },
  { text: "Se reventó la tubería", expected: "FLOODING" },
  {
    text: "My water heater está leaking y hay agua por todas partes",
    expected: "FLOODING",
  },

  // --- Sewage --------------------------------------------------------------
  { text: "Raw sewage is backing up into the tub", expected: "SEWAGE_BACKUP" },
  { text: "There's a toilet overflowing in the guest bath", expected: "SEWAGE_BACKUP" },
  { text: "Hay aguas negras en el baño", expected: "SEWAGE_BACKUP" },

  // --- Cold ----------------------------------------------------------------
  { text: "We have no heat and it's freezing in here", expected: "NO_HEAT_FREEZING" },
  { text: "No tengo calefacción y está congelando", expected: "NO_HEAT_FREEZING" },
  // The caller never says "freezing" — we know it from the weather.
  {
    text: "The furnace is out",
    expected: "NO_HEAT_FREEZING",
    context: { outdoorTempF: 18 },
  },
  {
    text: "No hay calefacción desde anoche",
    expected: "NO_HEAT_FREEZING",
    context: { outdoorTempF: 20 },
  },

  // --- Vulnerable person ---------------------------------------------------
  {
    text: "My basement is flooding and I have a newborn baby here",
    expected: "VULNERABLE_PERSON_AT_RISK",
  },
  {
    // No freezing cue and no temperature, so the cold rules stay silent — but
    // an elderly resident with no heat is still not a next-Tuesday job.
    text: "There's no heat and my elderly mother lives with me",
    expected: "VULNERABLE_PERSON_AT_RISK",
  },
  { text: "Hay humo y mi bebé está en la casa", expected: "VULNERABLE_PERSON_AT_RISK" },

  // Severity ordering: a gas leak in a house with a baby is a gas leak.
  { text: "There's a gas leak and my baby is upstairs", expected: "GAS_LEAK" },
];

/**
 * Routine home-services calls. Any hit here is a false positive that pages a
 * human for nothing, so the classifier is expected to stay silent on all of
 * them.
 */
export const SAFE_SAMPLES: readonly SafeSample[] = [
  { text: "My water heater is leaking a little bit under the tank" },
  { text: "We're installing new flooring next week" },
  { text: "The subfloor is warped where the old flooring was" },
  { text: "I need a quote for a new furnace" },
  { text: "My AC isn't cooling well" },
  { text: "The drain in the kitchen sink is slow" },
  { text: "Can someone come look at my gas fireplace?" },
  { text: "I'm calling about the gas bill" },
  { text: "The smoke detector needs a new battery" },
  { text: "It's freezing outside but the heat is working fine" },
  // "no heat" with no freezing cue and no cold weather is a routine job.
  { text: "No heat needed, just a tune-up before winter" },
  { text: "My kids' bathroom faucet drips" },
  { text: "My toilet runs constantly" },
  { text: "The pilot light went out" },
  { text: "I want to schedule annual maintenance" },
  { text: "Do you service Hialeah?" },
  { text: "How much for a water softener?" },
  { text: "The garbage disposal is jammed" },
  { text: "There's a small drip under the sink" },
  { text: "Can I get an estimate for repiping?" },
  { text: "The thermostat display is blank" },
  { text: "My dryer vent needs cleaning" },
  { text: "Necesito una cotización para un calentador nuevo" },
  { text: "El grifo gotea" },
  { text: "Quiero cambiar el piso de la cocina" },
  { text: "Mi lavadora no drena bien" },
  { text: "Está haciendo mucho frío pero la calefacción funciona" },
  { text: "Necesito servicio para el calentador de agua" },
];

/**
 * Utterances that are not emergencies but fire anyway. **These are deliberate.**
 *
 * The classifier does no negation or tense suppression, because suppressing a
 * hazard on "no" is how you miss "no, I mean there IS a gas leak". A false
 * positive costs one annoyed dispatcher; a false negative costs a house.
 *
 * They live in a test so that if someone ever "fixes" them, the trade-off is a
 * conscious decision with a failing test attached, rather than a silent
 * regression in the one component that must not have false negatives.
 */
export const KNOWN_FALSE_POSITIVES: readonly SafeSample[] = [
  { text: "I'm not smelling any gas, I just want it checked" },
  { text: "Please make sure there is no gas leak" },
  { text: "We had a flood two years ago in the basement" },
];
