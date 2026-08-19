export * as SideQuestionEvent from "./side-question-event"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"

// Live-only (never durable): side-question answers are ephemeral by design and
// deltas exist purely to mirror generation progress into the TUI panel.
// `sideQuestionID` correlates one in-flight ask so a client can ignore deltas
// from superseded or unrelated asks; it is caller-supplied when given and
// server-generated otherwise.
export const Delta = Event.define({
  type: "side_question.delta",
  schema: {
    sessionID: SessionID,
    sideQuestionID: Schema.String,
    delta: Schema.String,
  },
})

export const Definitions = Event.inventory(Delta)
