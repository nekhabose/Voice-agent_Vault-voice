import { Fragment } from "react";
import { STATE_SPECS, type CallState } from "@ledgerline/contracts";

/**
 * The happy path, walked from the machine definition rather than restated here.
 * If someone inserts a state in `packages/contracts`, this renders it.
 */
const HAPPY_PATH: CallState[] = (() => {
  const path: CallState[] = [];
  let cursor: CallState | null = "GREETING";
  while (cursor) {
    path.push(cursor);
    cursor = STATE_SPECS[cursor].next;
  }
  return path;
})();

/**
 * Shows the caller moving through the conversation graph.
 *
 * This is the clearest available explanation of how the product works: the
 * agent is not improvising, it is filling five fields in a fixed order — and a
 * dispatcher watching a live call can see exactly where it has got to.
 */
export function StateGraph({ current }: { current: CallState }) {
  const currentIndex = HAPPY_PATH.indexOf(current);

  return (
    <div className="graph" role="img" aria-label={`Call is at the ${current} step`}>
      {HAPPY_PATH.map((state, index) => {
        const done = currentIndex > index;
        const isCurrent = currentIndex === index;
        const className = ["node", done && "done", isCurrent && "current"]
          .filter(Boolean)
          .join(" ");

        return (
          <Fragment key={state}>
            {index > 0 && <span className={`edge${done || isCurrent ? " done" : ""}`} />}
            <span className={className}>
              <span className="node-dot" />
              <span className="node-label">{state}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
