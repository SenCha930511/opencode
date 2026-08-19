/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
// Static imports on purpose: submit-btw.test.tsx mocks the public dialog-btw-history
// and btw-history modules, so which module a lazy import() resolves to must not be
// load-order-dependent.
import { openBtwHistory } from "../../src/component/dialog-btw-history"
import { append, __setStateDir } from "../../src/prompt/btw-history.impl"
import type { DialogContext } from "../../src/ui/dialog"
import type { BtwEntry } from "../../src/prompt/btw-history.impl"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

const entry = (over: Partial<BtwEntry> = {}): BtwEntry => ({
  ts: Date.now(),
  sessionID: "ses_test",
  q: "question",
  a: "answer",
  model: "p1/m1",
  ...over,
})

async function mount(input: { root: string }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { RouteProvider, useRoute },
  ] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
    import("../../src/context/route"),
  ])
  __setStateDir(state)

  type ProbeContext = {
    dialog: DialogContext
    navigate: (sessionID: string) => void
  }

  function Harness(props: { ready: (ctx: ProbeContext) => void }) {
    function Probe() {
      const dialog = useDialog()
      const route = useRoute()
      onMount(() =>
        props.ready({
          dialog,
          navigate: (sessionID) => route.navigate({ type: "session", sessionID }),
        }),
      )
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
                  <RouteProvider>
                    <DialogProvider>
                      <Probe />
                    </DialogProvider>
                  </RouteProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  let ready!: (ctx: ProbeContext) => void
  const mounted = new Promise<ProbeContext>((resolve) => (ready = resolve))
  const app = await testRender(() => <Harness ready={ready} />, { kittyKeyboard: true })
  const ctx = await mounted
  return {
    app,
    ctx,
    append,
    openBtwHistory,
    frame() {
      return app.captureCharFrame()
    },
    async cleanup() {
      __setStateDir(undefined)
      app.renderer.destroy()
    },
  }
}

test("lists entries most-recent-first and selecting one shows the stored answer without any sdk", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    await tui.append(entry({ ts: 1, q: "older question alpha", a: "stored answer alpha aaa11", model: "p1/m1" }))
    await tui.append(entry({ ts: 2, q: "newer question beta", a: "stored answer beta bbb22", model: "p1/m2" }))

    tui.openBtwHistory({ dialog: tui.ctx.dialog, sessionID: "ses_test" })
    await wait(() => tui.frame().includes("/btw history"))
    const list = tui.frame()
    expect(list.indexOf("newer question beta")).toBeLessThan(list.indexOf("older question alpha"))
    expect(list).toContain("p1/m2")
    expect(list).toContain("d ago")

    tui.app.mockInput.pressEnter()
    await wait(() => tui.frame().includes("stored answer beta bbb22"))
    const overlay = tui.frame()
    expect(overlay).toContain("newer question beta")
    expect(overlay).toContain("esc, enter, space = dismiss")
  } finally {
    await tui.cleanup()
  }
})

test("does nothing when the session has no history entries", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.openBtwHistory({ dialog: tui.ctx.dialog, sessionID: "ses_empty" })
    await Bun.sleep(200)
    expect(tui.ctx.dialog.stack).toHaveLength(0)

    tui.ctx.navigate("ses_route")
    tui.openBtwHistory({ dialog: tui.ctx.dialog })
    await Bun.sleep(200)
    expect(tui.ctx.dialog.stack).toHaveLength(0)
  } finally {
    await tui.cleanup()
  }
})

test("resolves the session from the route context when no explicit sessionID is passed", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    tui.ctx.navigate("ses_route")
    await tui.append(entry({ sessionID: "ses_route", q: "route question", a: "route answer rrr33" }))

    // no solid owner here, matching the async interceptor path in prompt/index.tsx
    tui.openBtwHistory({ dialog: tui.ctx.dialog })
    await wait(() => tui.frame().includes("/btw history"))
    expect(tui.frame()).toContain("route question")
  } finally {
    await tui.cleanup()
  }
})
