/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { TextareaRenderable } from "@opentui/core"
import { beforeEach, expect, mock, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { append as seedEntry, __setStateDir } from "../../src/prompt/btw-history.impl"
import type { BtwEntry } from "../../src/prompt/btw-history.impl"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { DialogContext } from "../../src/ui/dialog"
import type { ToastContext } from "../../src/ui/toast"

const append = mock((_entry: { ts: number; sessionID: string; q: string; a: string; model: string }) =>
  Promise.resolve(),
)
mock.module("../../src/prompt/btw-history", () => ({ append }))

// Query-busted URL on purpose: a sibling test file mocks ../../src/component/dialog-btw
// by exact path, and which module this test's imports resolve to must not depend on
// in-process load order (mock.restore() does not undo mock.module).
const { DialogBtw, openBtwHistory } = (await import(
  "../../src/component/dialog-btw" + "?real"
)) as typeof import("../../src/component/dialog-btw")

beforeEach(() => {
  append.mockClear()
  DialogBtw.dismiss()
})

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type SideQuestionCall = {
  body: { question?: string }
  signal: AbortSignal | null
  promise: Promise<Response>
  resolve: (response: Response) => void
  reject: (error: unknown) => void
}

type AskContext = {
  dialog: DialogContext
  client: OpencodeClient
  toast: ToastContext
}

const TRANSCRIPT = "transcript anchor line zeta-913"

async function mount(input: { root: string }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  __setStateDir(state)

  const [
    { DialogProvider, useDialog },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, useToast },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { SDKProvider, useSDK },
  ] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
    import("../../src/context/sdk"),
  ])

  const calls: SideQuestionCall[] = []
  const base = createFetch()
  const fetcher = (async (req: RequestInfo | URL) => {
    const url = new URL(req instanceof Request ? req.url : String(req))
    if (url.pathname === "/session/ses_test/side-question") {
      const body = req instanceof Request ? ((await req.clone().json()) as { question?: string }) : {}
      const signal = req instanceof Request ? req.signal : null
      // Settlement stays test-driven (no auto-reject on abort) so late resolves
      // after cancellation still reach the component's success handler.
      let settle: { resolve: (response: Response) => void; reject: (error: unknown) => void } | undefined
      const promise = new Promise<Response>((resolve, reject) => (settle = { resolve, reject }))
      calls.push({ body, signal, promise, resolve: settle!.resolve, reject: settle!.reject })
      return await promise
    }
    return base.fetch(req)
  }) as typeof fetch

  let editor!: TextareaRenderable

  function Harness(props: { ready: (ctx: AskContext) => void }) {
    function Probe() {
      const dialog = useDialog()
      const sdk = useSDK()
      const toast = useToast()
      onMount(() => props.ready({ dialog, client: sdk.client, toast }))
      return <box />
    }

    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <SDKProvider url="http://test" directory={directory} events={eventSource()} fetch={fetcher}>
                    <DialogProvider>
                      <Probe />
                      <box flexDirection="column">
                        <text>{TRANSCRIPT}</text>
                        <DialogBtw />
                        <textarea
                          ref={(r: TextareaRenderable) => {
                            editor = r
                            setTimeout(() => {
                              if (!r.isDestroyed) r.focus()
                            }, 0)
                          }}
                        />
                      </box>
                    </DialogProvider>
                  </SDKProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  let ready!: (ctx: AskContext) => void
  const mounted = new Promise<AskContext>((resolve) => (ready = resolve))
  const app = await testRender(() => <Harness ready={ready} />, { kittyKeyboard: true })
  const ctx = await mounted
  await wait(() => editor.focused)
  return {
    app,
    ctx,
    calls,
    editor: () => editor,
    active: () => DialogBtw.active(),
    ask(question: string) {
      DialogBtw.ask(ctx, { sessionID: "ses_test", question })
    },
    history(sessionID: string) {
      openBtwHistory({ dialog: ctx.dialog, sessionID })
    },
    seed(entry: BtwEntry) {
      return seedEntry(entry)
    },
    frame() {
      return app.captureCharFrame()
    },
    async cleanup() {
      __setStateDir(undefined)
      app.renderer.destroy()
    },
  }
}

test("loading then answer render in the docked panel, never in the dialog stack", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("how many files?")
    await wait(() => tui.calls.length === 1)
    await wait(() => tui.frame().includes("how many files?") && tui.frame().includes("esc = cancel"))
    expect(tui.calls[0]?.body.question).toBe("how many files?")
    expect(tui.ctx.dialog.stack).toHaveLength(0)

    // docked invariant: transcript text stays visible above the panel
    const loading = tui.frame()
    expect(loading).toContain(TRANSCRIPT)
    expect(loading.indexOf(TRANSCRIPT)).toBeLessThan(loading.indexOf("/btw"))

    tui.calls[0]!.resolve(
      json({ answer: "side answer xyz42", model: { providerID: "p1", modelID: "m1" }, createdMs: 1 }),
    )
    await wait(() => tui.frame().includes("xyz42"))
    const answer = tui.frame()
    expect(answer).toContain("esc, enter, space = dismiss")
    expect(answer).not.toContain("esc = cancel")
    expect(answer.indexOf(TRANSCRIPT)).toBeLessThan(answer.indexOf("xyz42"))
    expect(tui.ctx.dialog.stack).toHaveLength(0)
  } finally {
    await tui.cleanup()
  }
})

test("shows error message in the panel when the request rejects", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("what broke?")
    await wait(() => tui.calls.length === 1)
    tui.calls[0]!.reject(new Error("boom-bqw8"))
    await wait(() => tui.frame().includes("boom-bqw8"))
    expect(tui.frame()).toContain("esc, enter, space = dismiss")
    expect(tui.ctx.dialog.stack).toHaveLength(0)
  } finally {
    await tui.cleanup()
  }
})

test("escape during loading aborts the request and dismisses the panel", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("cancel me")
    await wait(() => tui.calls.length === 1)
    await wait(() => tui.frame().includes("esc = cancel"))
    expect(tui.calls[0]?.signal?.aborted).toBe(false)

    tui.app.mockInput.pressEscape()
    await wait(() => tui.frame().includes("cancel me") === false)
    expect(tui.calls[0]?.signal?.aborted).toBe(true)
    await wait(() => tui.editor().focused)
  } finally {
    await tui.cleanup()
  }
})

test("a new ask aborts the previous in-flight ask", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("first question")
    await wait(() => tui.calls.length === 1)
    tui.ask("second question")
    await wait(() => tui.calls.length === 2)
    await wait(() => tui.calls[0]?.signal?.aborted === true)
    expect(tui.calls[1]?.signal?.aborted).toBe(false)
    expect(tui.calls[1]?.body.question).toBe("second question")
    await wait(() => tui.frame().includes("second question"))
    tui.calls[1]!.reject(new Error("done"))
    await wait(() => tui.frame().includes("done"))
  } finally {
    await tui.cleanup()
  }
})

test("enter and space dismiss the panel, the composer regains focus, and the dismiss key does not type", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("dismiss with enter")
    await wait(() => tui.calls.length === 1)
    tui.calls[0]!.resolve(
      json({ answer: "enter dismissal body", model: { providerID: "p1", modelID: "m1" }, createdMs: 1 }),
    )
    await wait(() => tui.frame().includes("enter dismissal body"))
    expect(tui.editor().focused).toBe(false)

    tui.app.mockInput.pressEnter()
    await wait(() => tui.frame().includes("enter dismissal body") === false)
    await wait(() => tui.editor().focused)
    expect(tui.editor().plainText).toBe("")

    tui.app.mockInput.pressKey("x")
    await wait(() => tui.editor().plainText === "x")
    tui.editor().clear()
    await wait(() => tui.editor().plainText === "")

    tui.ask("dismiss with space")
    await wait(() => tui.calls.length === 2)
    tui.calls[1]!.resolve(
      json({ answer: "space dismissal body", model: { providerID: "p1", modelID: "m1" }, createdMs: 1 }),
    )
    await wait(() => tui.frame().includes("space dismissal body"))
    await wait(() => !tui.editor().focused)

    tui.app.mockInput.pressKey(" ")
    await wait(() => tui.frame().includes("space dismissal body") === false)
    await wait(() => tui.editor().focused)
    expect(tui.editor().plainText).toBe("")
  } finally {
    await tui.cleanup()
  }
})

test("successful ask appends to btw history", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("remember this")
    await wait(() => tui.calls.length === 1)
    tui.calls[0]!.resolve(
      json({
        answer: "history body h7",
        model: { providerID: "p1", modelID: "m1", variant: "high" },
        createdMs: 1,
      }),
    )
    await wait(() => tui.frame().includes("history body h7"))
    await wait(() => append.mock.calls.length === 1)
    const entry = append.mock.calls[0]?.[0]
    expect(entry?.sessionID).toBe("ses_test")
    expect(entry?.q).toBe("remember this")
    expect(entry?.a).toBe("history body h7")
    expect(entry?.model).toBe("p1/m1 (high)")
    expect(typeof entry?.ts).toBe("number")
  } finally {
    await tui.cleanup()
  }
})

test("empty answer shows placeholder and double escape stays safe", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("say nothing")
    await wait(() => tui.calls.length === 1)
    tui.calls[0]!.resolve(json({ answer: "   ", model: { providerID: "p1", modelID: "m1" }, createdMs: 1 }))
    await wait(() => tui.frame().includes("(no answer)"))
    tui.app.mockInput.pressEscape()
    tui.app.mockInput.pressEscape()
    await wait(() => tui.frame().includes("(no answer)") === false)
  } finally {
    await tui.cleanup()
  }
})

async function flushed(call: SideQuestionCall) {
  let done = false
  void call.promise.then(
    () => (done = true),
    () => (done = true),
  )
  // registered after the component's .then on the same promise, so the
  // component's settle handler has already run when this resolves
  await wait(() => done)
  await Bun.sleep(50)
}

test("esc during loading drops a late answer with no render and no history entry", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("cancel then resolve")
    await wait(() => tui.calls.length === 1)
    await wait(() => tui.frame().includes("esc = cancel"))
    tui.app.mockInput.pressEscape()
    await wait(() => tui.calls[0]?.signal?.aborted === true)
    await wait(() => tui.frame().includes("cancel then resolve") === false)

    tui.calls[0]!.resolve(
      json({ answer: "zombie answer zz9", model: { providerID: "p1", modelID: "m1" }, createdMs: 1 }),
    )
    await flushed(tui.calls[0]!)
    expect(tui.frame()).not.toContain("zombie answer zz9")
    expect(append).not.toHaveBeenCalled()
  } finally {
    await tui.cleanup()
  }
})

test("superseding ask drops the previous result without render or history entry", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("first in flight")
    await wait(() => tui.calls.length === 1)
    tui.ask("second in flight")
    await wait(() => tui.calls.length === 2)
    await wait(() => tui.calls[0]?.signal?.aborted === true)

    tui.calls[0]!.resolve(
      json({ answer: "stale answer st4le", model: { providerID: "p1", modelID: "m1" }, createdMs: 1 }),
    )
    await flushed(tui.calls[0]!)
    expect(tui.frame()).not.toContain("stale answer st4le")
    expect(append).not.toHaveBeenCalled()

    tui.calls[1]!.resolve(
      json({ answer: "fresh answer fr3sh", model: { providerID: "p1", modelID: "m1" }, createdMs: 1 }),
    )
    await wait(() => tui.frame().includes("fresh answer fr3sh"))
    await wait(() => append.mock.calls.length === 1)
    expect(append.mock.calls[0]?.[0].a).toBe("fresh answer fr3sh")
  } finally {
    await tui.cleanup()
  }
})

test("history lists entries most-recent-first and selecting one shows the stored answer without any sdk call", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    await tui.seed({
      ts: 1,
      sessionID: "ses_test",
      q: "older question alpha",
      a: "stored answer alpha aaa11",
      model: "p1/m1",
    })
    await tui.seed({
      ts: 2,
      sessionID: "ses_test",
      q: "newer question beta",
      a: "stored answer beta bbb22",
      model: "p1/m2",
    })

    tui.history("ses_test")
    await wait(() => tui.frame().includes("newer question beta"))
    const list = tui.frame()
    expect(list.indexOf("newer question beta")).toBeLessThan(list.indexOf("older question alpha"))
    expect(list).toContain("p1/m2")
    expect(list).toContain("d ago")
    expect(list).toContain("enter = open")
    expect(tui.calls).toHaveLength(0)
    expect(tui.ctx.dialog.stack).toHaveLength(0)

    tui.app.mockInput.pressEnter()
    await wait(() => tui.frame().includes("stored answer beta bbb22"))
    const entry = tui.frame()
    expect(entry).toContain("newer question beta")
    expect(entry).toContain("esc = back")
    expect(tui.calls).toHaveLength(0)

    tui.app.mockInput.pressEscape()
    await wait(() => tui.frame().includes("older question alpha") && !tui.frame().includes("stored answer beta bbb22"))
    tui.app.mockInput.pressEscape()
    await wait(() => tui.frame().includes("newer question beta") === false)
    await wait(() => tui.editor().focused)
  } finally {
    await tui.cleanup()
  }
})

test("arrow keys move the list selection before opening an entry", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    await tui.seed({
      ts: 1,
      sessionID: "ses_test",
      q: "older question alpha",
      a: "stored answer alpha aaa11",
      model: "p1/m1",
    })
    await tui.seed({
      ts: 2,
      sessionID: "ses_test",
      q: "newer question beta",
      a: "stored answer beta bbb22",
      model: "p1/m2",
    })

    tui.history("ses_test")
    await wait(() => tui.frame().includes("newer question beta"))

    tui.app.mockInput.pressArrow("down")
    tui.app.mockInput.pressEnter()
    await wait(() => tui.frame().includes("stored answer alpha aaa11"))
    expect(tui.frame()).toContain("older question alpha")
    expect(tui.calls).toHaveLength(0)
  } finally {
    await tui.cleanup()
  }
})

test("opening history with no entries leaves the panel and the dialog stack untouched", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.history("ses_empty")
    await Bun.sleep(200)
    expect(tui.active()).toBe(false)
    expect(tui.ctx.dialog.stack).toHaveLength(0)
    expect(tui.frame()).toContain(TRANSCRIPT)
    expect(tui.frame()).not.toContain("/btw")
    expect(tui.editor().focused).toBe(true)
  } finally {
    await tui.cleanup()
  }
})
