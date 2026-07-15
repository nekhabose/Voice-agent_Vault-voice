import type { Scenario } from "./simulate.js";

/**
 * The personas from the plan: impatient, fragmentary, volunteers everything at
 * once, gives the address wrong the first time, changes their mind mid-call.
 *
 * Each is a falsifiable claim about the product. They run in CI on every change
 * to the conversation core.
 *
 * `hazard/*` scenarios are the exception: they assert what the *safety classifier*
 * does, which is bilingual on purpose even though the booking flow is not.
 */

const MIAMI = {
  line1: "1247 Calle Ocho",
  city: "Miami",
  state: "FL",
  postalCode: "33135",
};

export const MIAMI_FORMATTED = "1247 Calle Ocho, Miami, FL 33135";

const LAUDERDALE = {
  line1: "1500 E Las Olas Blvd",
  city: "Fort Lauderdale",
  state: "FL",
  postalCode: "33301",
};

/** Thursday 2 – 4 PM local, inside business hours. */
const THURSDAY = {
  startsAt: "2026-07-09T18:00:00.000Z",
  endsAt: "2026-07-09T20:00:00.000Z",
};

/** Friday, same hours. */
const FRIDAY = {
  startsAt: "2026-07-10T18:00:00.000Z",
  endsAt: "2026-07-10T20:00:00.000Z",
};

export const win = (w: { startsAt: string; endsAt: string }): string =>
  `${w.startsAt}/${w.endsAt}`;

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "english/straightforward",
    persona: "Polite, answers each question in order.",
    turns: [
      { text: "Hi, this is Daniel Okafor.", fills: [{ key: "caller_name", raw: "Daniel Okafor" }] },
      { text: "You can reach me at 786 555 0143.", fills: [{ key: "callback_phone", raw: "(786) 555-0143" }] },
      {
        text: "My kitchen sink is backing up. It can wait a day.",
        fills: [
          { key: "problem_description", raw: "Kitchen sink drain backing up" },
          { key: "urgency", raw: "ROUTINE" },
        ],
      },
      { text: "It's 1247 Calle Ocho, Miami, 33135.", fills: [{ key: "service_address", raw: MIAMI }] },
      { text: "Thursday afternoon works.", fills: [{ key: "appointment_window", raw: THURSDAY }] },
      { text: "Yes, that's all correct.", confirmsAll: true },
    ],
    expect: {
      outcome: "BOOKED",
      slots: {
        caller_name: "Daniel Okafor",
        service_address: MIAMI_FORMATTED,
        appointment_window: win(THURSDAY),
      },
    },
  },

  {
    name: "english/answers-in-fragments",
    persona: "Distracted, one clause at a time, never a full sentence.",
    turns: [
      { text: "Rosa Delgado.", fills: [{ key: "caller_name", raw: "Rosa Delgado" }] },
      { text: "305 555 7781.", fills: [{ key: "callback_phone", raw: "305-555-7781" }] },
      {
        text: "Water heater's leaking. Need someone today.",
        fills: [
          { key: "problem_description", raw: "Water heater leaking" },
          { key: "urgency", raw: "SAME_DAY" },
        ],
      },
      { text: "1247 Calle Ocho.", fills: [{ key: "service_address", raw: MIAMI }] },
      { text: "Thursday afternoon.", fills: [{ key: "appointment_window", raw: THURSDAY }] },
      { text: "Yeah, that's right.", confirmsAll: true },
    ],
    expect: {
      outcome: "BOOKED",
      slots: { caller_name: "Rosa Delgado", service_address: MIAMI_FORMATTED },
    },
  },

  {
    name: "english/volunteers-everything-up-front",
    persona: "Front-loads the whole call in one breath. Must not be re-interrogated.",
    turns: [
      {
        text: "Hi, it's Rosa at 1247 Calle Ocho, my heater's dead, can someone come Thursday afternoon?",
        fills: [
          { key: "caller_name", raw: "Rosa Delgado" },
          { key: "service_address", raw: MIAMI },
          { key: "problem_description", raw: "Heater is dead" },
          { key: "urgency", raw: "SAME_DAY" },
          { key: "appointment_window", raw: THURSDAY },
        ],
      },
      { text: "It's 305 555 7781.", fills: [{ key: "callback_phone", raw: "3055557781" }] },
      { text: "Yep, all right.", confirmsAll: true },
    ],
    expect: { outcome: "BOOKED", slots: { service_address: MIAMI_FORMATTED } },
  },

  {
    name: "english/changes-time-before-confirming",
    persona: "Says Thursday, changes to Friday before anything is read back.",
    turns: [
      { text: "Daniel Okafor.", fills: [{ key: "caller_name", raw: "Daniel Okafor" }] },
      { text: "786 555 0143.", fills: [{ key: "callback_phone", raw: "7865550143" }] },
      {
        text: "Slow drain, nothing urgent.",
        fills: [
          { key: "problem_description", raw: "Slow drain" },
          { key: "urgency", raw: "ROUTINE" },
        ],
      },
      { text: "1247 Calle Ocho.", fills: [{ key: "service_address", raw: MIAMI }] },
      { text: "Thursday afternoon.", fills: [{ key: "appointment_window", raw: THURSDAY }] },
      { text: "Actually, can we make it Friday?", fills: [{ key: "appointment_window", raw: FRIDAY }] },
      { text: "Yes, Friday.", confirmsAll: true },
    ],
    expect: { outcome: "BOOKED", slots: { appointment_window: win(FRIDAY) } },
  },

  {
    name: "english/corrects-an-address-she-already-confirmed",
    persona: "Confirms the address, then remembers the apartment number.",
    turns: [
      { text: "Daniel Okafor.", fills: [{ key: "caller_name", raw: "Daniel Okafor" }] },
      { text: "786 555 0143.", fills: [{ key: "callback_phone", raw: "7865550143" }] },
      {
        text: "Slow drain.",
        fills: [
          { key: "problem_description", raw: "Slow drain" },
          { key: "urgency", raw: "ROUTINE" },
        ],
      },
      { text: "1247 Calle Ocho.", fills: [{ key: "service_address", raw: MIAMI }] },
      { text: "Thursday afternoon.", fills: [{ key: "appointment_window", raw: THURSDAY }] },
      // Read-back order is canonical: phone, then address, then window.
      { text: "Yes, that's my number.", confirms: true },
      { text: "Yes, that's the address.", confirms: true },
      // ...and now the confirmed address is wrong. The gate must reopen.
      {
        text: "Oh wait — it's apartment 4.",
        fills: [{ key: "service_address", raw: { ...MIAMI, line2: "Apt 4" } }],
      },
      { text: "Yes, all correct now.", confirmsAll: true },
    ],
    expect: {
      outcome: "BOOKED",
      slots: { service_address: "1247 Calle Ocho Apt 4, Miami, FL 33135" },
    },
  },

  // The two scenarios below are the *product* being English-only and the *safety
  // classifier* not being. A Spanish-speaking homeowner can dial an English-only
  // shop, and panic reverts people to their first language. We will not book their
  // job in Spanish, but we will absolutely get them out of the house.
  // See `plan.md` principle #4 and `safety/english-only-pivot.test.ts`.
  {
    name: "hazard/spanish-utterance-on-an-english-line",
    persona: "Reverts to her first language the moment she smells gas.",
    turns: [
      { text: "Hi, this is Marisol.", fills: [{ key: "caller_name", raw: "Marisol Peña" }] },
      { text: "Huele a gas en la cocina, no sé qué hacer." },
      { text: "Okay, I'm going outside." },
    ],
    expect: { outcome: "ESCALATED_EMERGENCY", hazard: "GAS_LEAK" },
  },

  {
    name: "hazard/spanish-no-heat-in-a-freeze",
    persona: "Never says 'freezing'. We know it is, from the weather.",
    outdoorTempF: 18,
    turns: [{ text: "No tengo calefacción desde anoche." }],
    expect: { outcome: "ESCALATED_EMERGENCY", hazard: "NO_HEAT_FREEZING" },
  },

  {
    name: "english/no-heat-in-july",
    persona: "Same words, 78°F outside. A routine job, not an emergency.",
    outdoorTempF: 78,
    turns: [
      { text: "There's no heat.", fills: [{ key: "problem_description", raw: "No heat" }] },
      { text: "Greg Whitman.", fills: [{ key: "caller_name", raw: "Greg Whitman" }] },
      { text: "786 555 2204.", fills: [{ key: "callback_phone", raw: "7865552204" }] },
      { text: "Not urgent.", fills: [{ key: "urgency", raw: "ROUTINE" }] },
      { text: "1247 Calle Ocho.", fills: [{ key: "service_address", raw: MIAMI }] },
      { text: "Thursday.", fills: [{ key: "appointment_window", raw: THURSDAY }] },
      { text: "Correct.", confirmsAll: true },
    ],
    expect: { outcome: "BOOKED" },
  },

  {
    name: "english/outside-service-area",
    persona: "Real address, wrong county.",
    turns: [
      { text: "Priya Raman.", fills: [{ key: "caller_name", raw: "Priya Raman" }] },
      { text: "954 555 0077.", fills: [{ key: "callback_phone", raw: "9545550077" }] },
      {
        text: "Leaky faucet, whenever.",
        fills: [
          { key: "problem_description", raw: "Leaky faucet" },
          { key: "urgency", raw: "ROUTINE" },
        ],
      },
      { text: "1500 East Las Olas Boulevard, Fort Lauderdale.", fills: [{ key: "service_address", raw: LAUDERDALE }] },
    ],
    expect: { outcome: "OUT_OF_SERVICE_AREA" },
  },

  {
    name: "english/address-not-real",
    persona: "Gives an address the geocoder has never heard of, then the right one.",
    turns: [
      { text: "Hannah Cole.", fills: [{ key: "caller_name", raw: "Hannah Cole" }] },
      { text: "305 555 1188.", fills: [{ key: "callback_phone", raw: "3055551188" }] },
      {
        text: "Running toilet.",
        fills: [
          { key: "problem_description", raw: "Running toilet" },
          { key: "urgency", raw: "ROUTINE" },
        ],
      },
      {
        text: "It's 9999 Nowhere Lane.",
        fills: [{ key: "service_address", raw: { line1: "9999 Nowhere Lane", city: "Miami", state: "FL", postalCode: "33135" } }],
      },
      { text: "Sorry — 1247 Calle Ocho.", fills: [{ key: "service_address", raw: MIAMI }] },
      { text: "Thursday afternoon.", fills: [{ key: "appointment_window", raw: THURSDAY }] },
      { text: "That's right.", confirmsAll: true },
    ],
    expect: { outcome: "BOOKED", slots: { service_address: MIAMI_FORMATTED } },
  },

  {
    name: "english/unintelligible-phone-number",
    persona: "Bad line. The agent cannot get the number and should stop trying.",
    turns: [
      { text: "Hi there.", fills: [{ key: "caller_name", raw: "Unknown" }] },
      { text: "It's, uh...", fills: [{ key: "callback_phone", raw: "call me maybe" }] },
      { text: "Sorry, can you hear me?", fills: [{ key: "callback_phone", raw: "mumble" }] },
      { text: "Hello?", fills: [{ key: "callback_phone", raw: "nothing" }] },
    ],
    expect: { outcome: "ESCALATED_OTHER" },
  },

  {
    name: "english/asks-for-a-person",
    persona: "Does not want to talk to a robot.",
    turns: [
      { text: "Can I just talk to a person?", requestsHuman: true },
    ],
    expect: { outcome: "ESCALATED_OTHER" },
  },

  {
    name: "english/hangs-up",
    persona: "Gone before the greeting finishes.",
    turns: [{ text: "...", hangsUp: true }],
    expect: { outcome: "CALLER_HUNG_UP" },
  },
];
