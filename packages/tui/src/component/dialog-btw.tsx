import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Match, Switch, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import type { ToastContext } from "../ui/toast"
import type { BtwEntry } from "../prompt/btw-history.impl"
import { useBindings } from "../keymap"

type BtwState = {
  status: "idle" | "loading" | "answer" | "error"
  question: string
  answer: string
  model: string
  error: string
}

const initial: BtwState = { status: "idle", question: "", answer: "", model: "", error: "" }

const [state, setState] = createStore<BtwState>(initial)
let inFlight: AbortController | undefined

export type DialogBtwContext = {
  dialog: DialogContext
  client: OpencodeClient
  toast: ToastContext
}

type BtwHistory = {
  append(entry: BtwEntry): Promise<void>
}

export function DialogBtw() {
  const dialog = useDialog()
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()

  onMount(() => dialog.setSize("large"))

  useBindings(() => ({
    enabled: state.status === "answer" || state.status === "error",
    bindings: [
      { key: "return", desc: "Dismiss side question", group: "Dialog", cmd: () => dialog.clear() },
      { key: "space", desc: "Dismiss side question", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            /btw
          </text>
          <text fg={theme.textMuted}>{state.question}</text>
        </box>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Switch>
        <Match when={state.status === "loading"}>
          <text fg={theme.textMuted}>…</text>
        </Match>
        <Match when={state.status === "error"}>
          <text fg={theme.error}>{state.error}</text>
        </Match>
        <Match when={state.status === "answer"}>
          <scrollbox maxHeight={Math.max(8, Math.floor(dimensions().height / 2))} flexShrink={1}>
            <markdown
              syntaxStyle={syntax()}
              streaming={true}
              internalBlockMode="top-level"
              content={state.answer}
              tableOptions={{ style: "grid" }}
              conceal={true}
              fg={theme.markdownText}
              bg={theme.backgroundPanel}
            />
          </scrollbox>
        </Match>
      </Switch>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{state.status === "loading" ? "esc = cancel" : "esc, enter, space = dismiss"}</text>
      </box>
    </box>
  )
}

DialogBtw.ask = (ctx: DialogBtwContext, input: { sessionID: string; question: string }) => {
  inFlight?.abort()
  const ctrl = new AbortController()
  inFlight = ctrl
  setState({ status: "loading", question: input.question, answer: "", model: "", error: "" })
  ctx.dialog.replace(
    () => <DialogBtw />,
    () => ctrl.abort(),
  )
  void ctx.client.session
    .sideQuestion({ sessionID: input.sessionID, question: input.question }, { signal: ctrl.signal, throwOnError: true })
    .then((result) => {
      // A cancelled ask must produce no side effects: a response that resolves
      // after esc-abort (or after being superseded by a newer ask) is dropped
      // before any state update, render, or history append. Superseded asks are
      // also abort()ed, so the predicates overlap; the identity check still
      // guards a replace path that resolves before the abort signal lands.
      if (inFlight !== ctrl || ctrl.signal.aborted) return
      const model = `${result.data.model.providerID}/${result.data.model.modelID}${result.data.model.variant ? ` (${result.data.model.variant})` : ""}`
      const answer = result.data.answer.trim() ? result.data.answer : "(no answer)"
      setState({ status: "answer", answer, model })
      if (answer === "(no answer)") {
        ctx.toast.show({ variant: "warning", message: "The model returned an empty answer" })
      }
      const entry = { ts: Date.now(), sessionID: input.sessionID, q: input.question, a: result.data.answer, model }
      // btw-history is built by a parallel worker; the non-literal specifier keeps this
      // module compiling and the ask succeeding (with a toast warning) before it lands.
      void import("../prompt/" + "btw-history")
        .then((mod: BtwHistory) => mod.append(entry))
        .catch(() => ctx.toast.show({ variant: "warning", message: "Could not save /btw answer to history" }))
    })
    .catch((err: unknown) => {
      if (inFlight !== ctrl || ctrl.signal.aborted) return
      setState({
        status: "error",
        error: err instanceof Error ? err.message : "side-question failed",
      })
    })
}
