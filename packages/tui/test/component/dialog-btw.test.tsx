/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { beforeEach, expect, mock, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { DialogContext } from "../../src/ui/dialog"
import type { ToastContext } from "../../src/ui/toast"

const append = mock((_entry: { ts: number; sessionID: string; q: string; a: string; model: string }) =>
  Promise.resolve(),
)
mock.module("../../src/prompt/btw-history", () => ({ append }))

beforeEach(() => {
  append.mockClear()
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

async function mount(input: { root: string }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

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

  // Query-busted URL on purpose: a sibling test file mocks ../../src/component/dialog-btw
  // by exact path, and which module this test's imports resolve to must not depend on
  // in-process load order (mock.restore() does not undo mock.module).
  const { DialogBtw } = (await import(
    "../../src/component/dialog-btw" + "?real"
  )) as typeof import("../../src/component/dialog-btw")

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
  return {
    app,
    calls,
    ask(question: string) {
      DialogBtw.ask(ctx, { sessionID: "ses_test", question })
    },
    frame() {
      return app.captureCharFrame()
    },
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("shows loading then answer with dismiss hint", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("how many files?")
    await wait(() => tui.calls.length === 1)
    await wait(() => tui.frame().includes("how many files?") && tui.frame().includes("esc = cancel"))
    expect(tui.calls[0]?.body.question).toBe("how many files?")

    tui.calls[0]!.resolve(
      json({ answer: "side answer xyz42", model: { providerID: "p1", modelID: "m1" }, createdMs: 1 }),
    )
    await wait(() => tui.frame().includes("xyz42"))
    expect(tui.frame()).toContain("esc, enter, space = dismiss")
    expect(tui.frame()).not.toContain("esc = cancel")
  } finally {
    await tui.cleanup()
  }
})

test("shows error message when the request rejects", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("what broke?")
    await wait(() => tui.calls.length === 1)
    tui.calls[0]!.reject(new Error("boom-bqw8"))
    await wait(() => tui.frame().includes("boom-bqw8"))
    expect(tui.frame()).toContain("esc, enter, space = dismiss")
  } finally {
    await tui.cleanup()
  }
})

test("escape during loading aborts the request and dismisses", async () => {
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

test("enter and space dismiss the answer", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ask("dismiss with enter")
    await wait(() => tui.calls.length === 1)
    tui.calls[0]!.resolve(
      json({ answer: "enter dismissal body", model: { providerID: "p1", modelID: "m1" }, createdMs: 1 }),
    )
    await wait(() => tui.frame().includes("enter dismissal body"))
    tui.app.mockInput.pressEnter()
    await wait(() => tui.frame().includes("enter dismissal body") === false)

    tui.ask("dismiss with space")
    await wait(() => tui.calls.length === 2)
    tui.calls[1]!.resolve(
      json({ answer: "space dismissal body", model: { providerID: "p1", modelID: "m1" }, createdMs: 1 }),
    )
    await wait(() => tui.frame().includes("space dismissal body"))
    tui.app.mockInput.pressKey(" ")
    await wait(() => tui.frame().includes("space dismissal body") === false)
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
