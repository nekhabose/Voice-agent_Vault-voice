/**
 * Task 5.5 / plan §11 — score the extractor against a **live** model.
 *
 * Every eval run this repo has ever done bound `FakeExtractor`, scripted from the
 * scenario's own fills. That proves the port, the validators, and the machine
 * carry a value through intact. It cannot prove the *model heard it*, and the
 * model is the part the literature says fails: VoiceAgentBench puts the best
 * ASR→LLM pipeline at 60.6% on tool-call parameter fill, and that number is the
 * reason this entire architecture exists. We have never had our own.
 *
 * This script produces it. Same scenarios, same machine, same validators, same
 * `SlotExtractor` port — a live model behind it instead of a fake.
 *
 * It also runs the A/B that `packages/groq` exists to make possible: each model,
 * in whichever structured-output mode it supports, scored on **accuracy and
 * latency together**. Those two cannot be traded off freely here. `checkBudgets()`
 * blocks a merge at p95 first word > 1.2s, and the extraction call is inside that
 * budget — so a model that is 4% more accurate and 900ms slower is not a better
 * model, it is a model that fails the budget. Principle #5: you cannot buy latency
 * with silence, and you cannot buy accuracy with latency either.
 *
 * Usage — the key is read from the environment and never printed:
 *
 *   npx tsx --env-file=.env scripts/score-extractor.ts
 *   npx tsx --env-file=.env scripts/score-extractor.ts llama-3.1-8b-instant
 *
 * Nothing here is in the PR suite. `npm test` makes zero live model calls, and
 * that is deliberate: a suite whose green depends on a third party's uptime
 * teaches the team to ignore red.
 */
import { groqClient } from "@ledgerline/groq";
import { evalDeps, groqExtractor, runAll, SCENARIOS } from "@ledgerline/eval";
import { modeFor } from "@ledgerline/groq";

/** The candidates. Measured live: each supports exactly one structured-output mode. */
const MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
  "qwen/qwen3-32b",
];

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error(
    "GROQ_API_KEY is not set. Run with: npx tsx --env-file=.env scripts/score-extractor.ts",
  );
  process.exit(1);
}

const client = groqClient({ apiKey, maxRetries: 2 });
const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : MODELS;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const ms = (n: number) => `${Math.round(n)}ms`;

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

interface Row {
  readonly model: string;
  readonly mode: string;
  readonly accuracy: number;
  readonly containment: number;
  readonly outcomes: number;
  readonly p50: number;
  readonly p95: number;
  readonly calls: number;
  readonly failures: readonly string[];
  readonly error?: string;
}

const rows: Row[] = [];

for (const model of models) {
  const mode = modeFor(model);
  const latencies: number[] = [];

  // Time the port, not the SDK: wrap the extractor so every `extract()` the
  // machine makes is measured, including the ones that come back `absent`.
  const base = groqExtractor(client, { model });
  const timed = (scenario: Parameters<typeof base>[0]) => {
    const extractor = base(scenario);
    return {
      extract: async (...args: Parameters<typeof extractor.extract>) => {
        const started = performance.now();
        try {
          return await extractor.extract(...args);
        } finally {
          latencies.push(performance.now() - started);
        }
      },
    };
  };

  process.stderr.write(`\n${model} (${mode}) … `);

  try {
    const { score } = await runAll(SCENARIOS, {
      ...evalDeps(),
      makeExtractor: timed,
    });

    latencies.sort((a, b) => a - b);
    rows.push({
      model,
      mode,
      accuracy: score.criticalSlotAccuracy,
      containment: score.containmentRate,
      outcomes: score.outcomeAccuracy,
      p50: quantile(latencies, 0.5),
      p95: quantile(latencies, 0.95),
      calls: latencies.length,
      failures: score.failures,
    });
    process.stderr.write("done\n");
  } catch (error) {
    // A model that throws is a model we cannot ship, and the reason is the point:
    // an unrecognised 400 here is our bug (a schema we broke), while a 404 is a
    // model that does not exist. `degradeReasonOrThrow` already made that call.
    const reason = error instanceof Error ? error.message : String(error);
    rows.push({
      model,
      mode,
      accuracy: 0,
      containment: 0,
      outcomes: 0,
      p50: 0,
      p95: 0,
      calls: latencies.length,
      failures: [],
      error: reason,
    });
    process.stderr.write(`THREW\n`);
  }
}

console.log(
  `\n${SCENARIOS.length} scenarios, through the real machine, classifier, validators, and SlotExtractor port.\n`,
);
console.log(
  ["model", "mode", "crit-slot", "contain", "outcome", "p50", "p95", "calls"]
    .map((h, i) => (i === 0 ? h.padEnd(26) : h.padStart(10)))
    .join(""),
);

for (const row of rows) {
  if (row.error) {
    console.log(`${row.model.padEnd(26)}${row.mode.padStart(10)}   ERROR: ${row.error.slice(0, 60)}`);
    continue;
  }
  console.log(
    [
      row.model.padEnd(26),
      row.mode.padStart(10),
      pct(row.accuracy).padStart(10),
      pct(row.containment).padStart(10),
      pct(row.outcomes).padStart(10),
      ms(row.p50).padStart(10),
      ms(row.p95).padStart(10),
      String(row.calls).padStart(10),
    ].join(""),
  );
}

// The budget is not advisory. `checkBudgets()` blocks a merge at p95 first word
// > 1.2s, and the extraction call is inside that budget — it is not the whole of
// it (TTS and the network are still to come), so a model at 1.1s here has already
// spent the entire allowance and left nothing for speaking.
const P95_EXTRACTION_BUDGET_MS = 800;
console.log(
  `\nExtraction p95 budget: ${P95_EXTRACTION_BUDGET_MS}ms — the p95 first-word budget is 1.2s and TTS is not free.`,
);

for (const row of rows) {
  if (row.error) continue;
  const overBudget = row.p95 > P95_EXTRACTION_BUDGET_MS;
  const verdict = overBudget ? "OVER BUDGET" : "within budget";
  console.log(`  ${row.model.padEnd(26)} ${ms(row.p95).padStart(8)}  ${verdict}`);
}

const failing = rows.filter((r) => !r.error && r.failures.length > 0);
if (failing.length > 0) {
  console.log("\nWhere the models got it wrong — this is the wedge, so read it:\n");
  for (const row of failing) {
    console.log(`  ${row.model} (${row.mode}):`);
    for (const failure of row.failures) console.log(`    - ${failure}`);
  }
}

console.log(
  "\nA fake extractor scores 100% here by construction. Any number below that is the",
);
console.log("first honest measurement of the thing this product is a bet against.\n");
