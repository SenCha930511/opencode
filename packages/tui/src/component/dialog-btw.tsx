import { TextAttributes, type MarkdownRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"
import { SplitBorder } from "../ui/border"
import type { DialogContext } from "../ui/dialog"
import type { ToastContext } from "../ui/toast"
import { read, type BtwEntry } from "../prompt/btw-history.impl"
import { useBindings, useOpencodeModeStack } from "../keymap"

type BtwState = {
  status: "idle" | "loading" | "answer" | "error" | "list" | "entry"
  question: string
  answer: string
  model: string
  error: string
  entries: BtwEntry[]
  selected: number
}

// Solid stores wrap and mutate the object passed to createStore, so every reset
// must merge a fresh literal rather than a shared initial object.
const initial = (): BtwState => ({
  status: "idle",
  question: "",
  answer: "",
  model: "",
  error: "",
  entries: [],
  selected: 0,
})

const [state, setState] = createStore<BtwState>(initial())
let inFlight: AbortController | undefined

function dismiss() {
  setState(initial())
}

export type DialogBtwContext = {
  dialog: DialogContext
  client: OpencodeClient
  toast: ToastContext
}

export type BtwHistoryContext = {
  dialog: DialogContext
  sessionID: string
}

type BtwHistory = {
  append(entry: BtwEntry): Promise<void>
}

// The docked panel must keep stream-level bindings (base mode) from firing while
// it is open, so it owns its own mode for its lifetime, mirroring dialogs' "modal".
const BTW_MODE = "btw"

export function DialogBtw() {
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const modeStack = useOpencodeModeStack()

  let scroll: ScrollBoxRenderable | undefined

  // Opening any non-idle state blurs the composer with the same focus handoff
  // dialogs use; dismissal restores whatever was focused, guarded against
  // destroyed/detached renderables exactly like the dialog provider. The pause
  // sentinel gates mode push/blur to the idle->open transition only: solid's
  // effect re-evaluates on every tracked store read (even equal results), so
  // the loading->answer->dismiss lifecycle must not reland the blur or refocus.
  let pause: { restore: Renderable | null; popMode: () => void } | undefined

  function deactivate() {
    const current = pause
    pause = undefined
    if (!current) return
    current.popMode()
    const restore = current.restore
    if (!restore) return
    setTimeout(() => {
      if (restore.isDestroyed) return
      function find(item: Renderable): boolean {
        for (const child of item.getChildren()) {
          if (child === restore) return true
          if (find(child)) return true
        }
        return false
      }
      if (!find(renderer.root)) return
      restore.focus()
    }, 1)
  }

  createEffect(() => {
    if (state.status === "idle") {
      deactivate()
      return
    }
    if (pause) return
    const restore = renderer.currentFocusedRenderable
    restore?.blur()
    pause = { restore, popMode: modeStack.push(BTW_MODE) }
  })

  onCleanup(deactivate)

  function escape() {
    if (state.status === "loading") {
      inFlight?.abort()
      dismiss()
      return
    }
    if (state.status === "entry") {
      setState("status", "list")
      return
    }
    dismiss()
  }

  function confirm() {
    if (state.status === "loading") return
    if (state.status === "list") {
      if (state.entries.length === 0) return
      setState("status", "entry")
      return
    }
    dismiss()
  }

  // Every list row renders as exactly two lines (truncated title + metadata), so
  // selected * 2 is the row's top line for scroll-into-view math.
  function move(direction: -1 | 1) {
    const count = state.entries.length
    if (count === 0) return
    const next = (state.selected + direction + count) % count
    setState("selected", next)
    if (!scroll) return
    const top = next * 2
    const height = listHeight()
    if (top < scroll.scrollTop) scroll.scrollBy(top - scroll.scrollTop)
    if (top + 2 > scroll.scrollTop + height) scroll.scrollBy(top + 2 - scroll.scrollTop - height)
  }

  useBindings(() => ({
    mode: BTW_MODE,
    enabled: state.status === "list",
    bindings: [
      { key: "up", desc: "Previous side question", group: "/btw", cmd: () => move(-1) },
      { key: "down", desc: "Next side question", group: "/btw", cmd: () => move(1) },
    ],
  }))

  useBindings(() => ({
    mode: BTW_MODE,
    enabled: state.status !== "idle",
    bindings: [
      { key: "escape", desc: "Dismiss side question", group: "/btw", cmd: () => escape() },
      { key: "return", desc: "Open or dismiss side question", group: "/btw", cmd: () => confirm() },
      { key: "space", desc: "Open or dismiss side question", group: "/btw", cmd: () => confirm() },
    ],
  }))

  const bodyHeight = createMemo(() => Math.max(4, Math.min(14, dimensions().height - 12)))
  const listHeight = createMemo(() => Math.min(bodyHeight(), state.entries.length * 2))

  // A scrollbox is flexGrow-shaped and would reserve its full max height even for
  // a one-line answer, so short bodies render in a plain clamped box and only a
  // measured-tall body swaps to the scrollbox (which keeps the ~14-row cap).
  const [tall, setTall] = createSignal(false)
  const body = createMemo(() => (state.status === "entry" ? state.entries[state.selected]?.a : state.answer) ?? "")

  createEffect(() => {
    body()
    setTall(false)
  })

  function onBodySize(this: MarkdownRenderable) {
    if (this.height > bodyHeight()) setTall(true)
  }

  function line(q: string) {
    const collapsed = q.replace(/\s+/g, " ").trim()
    const budget = Math.max(20, dimensions().width - 10)
    if (collapsed.length > budget) return collapsed.slice(0, budget - 1) + "…"
    return collapsed
  }

  const question = createMemo(() => {
    if (state.status === "entry") return line(state.entries[state.selected]?.q ?? "")
    return line(state.question)
  })

  const hint = createMemo(() => {
    if (state.status === "loading") return "esc = cancel"
    if (state.status === "list") return "up/down = select, enter = open, esc = dismiss"
    if (state.status === "entry") return "esc = back, enter/space = dismiss"
    return "esc, enter, space = dismiss"
  })

  return (
    <Show when={state.status !== "idle"}>
      <box
        backgroundColor={theme.backgroundPanel}
        border={["left"]}
        borderColor={theme.accent}
        customBorderChars={SplitBorder.customBorderChars}
        flexShrink={0}
      >
        <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <box flexDirection="row" gap={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              /btw
            </text>
            <text fg={theme.textMuted}>{question()}</text>
          </box>
          <Switch>
            <Match when={state.status === "loading"}>
              <text fg={theme.textMuted}>…</text>
            </Match>
            <Match when={state.status === "error"}>
              <text fg={theme.error}>{state.error}</text>
            </Match>
            <Match when={state.status === "answer" || state.status === "entry"}>
              {tall() ? (
                <scrollbox height={bodyHeight()} flexShrink={1}>
                  <markdown
                    syntaxStyle={syntax()}
                    streaming={true}
                    internalBlockMode="top-level"
                    content={body()}
                    tableOptions={{ style: "grid" }}
                    conceal={true}
                    fg={theme.markdownText}
                    bg={theme.backgroundPanel}
                  />
                </scrollbox>
              ) : (
                <box>
                  <markdown
                    onSizeChange={onBodySize}
                    syntaxStyle={syntax()}
                    streaming={true}
                    internalBlockMode="top-level"
                    content={body()}
                    tableOptions={{ style: "grid" }}
                    conceal={true}
                    fg={theme.markdownText}
                    bg={theme.backgroundPanel}
                  />
                </box>
              )}
            </Match>
            <Match when={state.status === "list"}>
              <scrollbox ref={(r: ScrollBoxRenderable) => (scroll = r)} height={listHeight()} flexShrink={1}>
                <For each={state.entries}>
                  {(entry, index) => {
                    const active = () => index() === state.selected
                    return (
                      <box
                        onMouseOver={() => setState("selected", index())}
                        onMouseUp={() => {
                          if (renderer.getSelection()?.getSelectedText()) return
                          setState({ selected: index(), status: "entry" })
                        }}
                      >
                        <box
                          flexDirection="row"
                          gap={1}
                          backgroundColor={active() ? theme.backgroundElement : undefined}
                        >
                          <text fg={theme.textMuted}>{active() ? ">" : " "}</text>
                          <text fg={active() ? theme.text : theme.textMuted}>{line(entry.q)}</text>
                        </box>
                        <box paddingLeft={2}>
                          <text fg={theme.textMuted}>
                            {relative(entry.ts)} · {entry.model}
                          </text>
                        </box>
                      </box>
                    )
                  }}
                </For>
              </scrollbox>
            </Match>
          </Switch>
          <box>
            <text fg={theme.textMuted}>{hint()}</text>
          </box>
        </box>
      </box>
    </Show>
  )
}

DialogBtw.active = () => state.status !== "idle"

DialogBtw.dismiss = dismiss

DialogBtw.ask = (ctx: DialogBtwContext, input: { sessionID: string; question: string }) => {
  inFlight?.abort()
  const ctrl = new AbortController()
  inFlight = ctrl
  setState({ ...initial(), status: "loading", question: input.question })
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

/**
 * Opens the /btw history browser as an inline list above the composer. No-op
 * when the session has no entries; empty-state toasting is the caller's job.
 */
export function openBtwHistory(ctx: BtwHistoryContext): void {
  // Opening history replaced an in-flight ask's overlay in the dialog stack (whose
  // close handler aborted it), so the panel must kill the ask itself here.
  inFlight?.abort()
  void read(ctx.sessionID).then((entries) => {
    if (entries.length === 0) return
    setState({ ...initial(), status: "list", entries })
  })
}

/** Palette command surface for bare /btw; mirrors the submit interceptor's bare path. */
export function btwSessionCommand(deps: {
  sessionID(): string | undefined
  dialog: DialogContext
  toast: ToastContext
}) {
  const usage = () =>
    deps.toast.show({
      variant: "info",
      message: "/btw <question> - ask a side question about the current session",
    })
  return {
    name: "session.btw",
    title: "Ask a side question",
    category: "Session",
    slashName: "btw",
    run: async () => {
      const sessionID = deps.sessionID()
      if (!sessionID) {
        usage()
        return
      }
      const entries = await read(sessionID)
      if (entries.length === 0) {
        usage()
        return
      }
      deps.dialog.clear()
      openBtwHistory({ dialog: deps.dialog, sessionID })
    },
  }
}

function relative(ts: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
