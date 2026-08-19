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
import type { DialogContext } from "../../src/ui/dialog"
import type { ToastContext } from "../../src/ui/toast"
import type { useLocal } from "../../src/context/local"
import type { PromptRef } from "../../src/component/prompt"

type BtwEntry = { ts: number; sessionID: string; q: string; a: string; model: string }

const ask = mock((_ctx: unknown, _input: { sessionID: string; question: string }) => {})
const openBtwHistory = mock((_ctx: { dialog: DialogContext; sessionID: string }) => {})
mock.module("../../src/component/dialog-btw", () => ({
  DialogBtw: Object.assign(() => null, { ask, active: () => false, dismiss: () => {} }),
  openBtwHistory,
}))

const read = mock((_sessionID: string): Promise<BtwEntry[]> => Promise.resolve([]))
mock.module("../../src/prompt/btw-history", () => ({
  read,
  append: mock((_entry: BtwEntry) => Promise.resolve()),
}))

beforeEach(() => {
  ask.mockClear()
  openBtwHistory.mockClear()
  read.mockClear()
  read.mockImplementation(() => Promise.resolve([]))
})

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type PostedCall = {
  method: string
  pathname: string
  body: any
}

type Probed = {
  dialog: DialogContext
  toast: ToastContext
  local: ReturnType<typeof useLocal>
}

async function mount(input: { root: string; sessionID?: string }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, Toast, useToast },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { SDKProvider },
    { ArgsProvider },
    { PermissionProvider },
    { RouteProvider },
    { ProjectProvider },
    { SyncProvider },
    { DataProvider },
    { LocalProvider, useLocal },
    { PromptStashProvider },
    { PromptHistoryProvider },
    { FrecencyProvider },
    { EditorContextProvider },
    { LocationProvider },
    { ExitProvider },
    { Prompt },
  ] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
    import("../../src/context/sdk"),
    import("../../src/context/args"),
    import("../../src/context/permission"),
    import("../../src/context/route"),
    import("../../src/context/project"),
    import("../../src/context/sync"),
    import("../../src/context/data"),
    import("../../src/context/local"),
    import("../../src/prompt/stash"),
    import("../../src/prompt/history"),
    import("../../src/prompt/frecency"),
    import("../../src/context/editor"),
    import("../../src/context/location"),
    import("../../src/context/exit"),
    import("../../src/component/prompt"),
  ])

  const posted: PostedCall[] = []
  const base = createFetch()
  const fetcher = (async (req: RequestInfo | URL) => {
    const request = req instanceof Request ? req : new Request(String(req))
    const url = new URL(request.url)
    if (request.method === "POST") {
      const body = await request
        .clone()
        .json()
        .catch(() => undefined)
      posted.push({ method: request.method, pathname: url.pathname, body })
      if (url.pathname === "/session") {
        return json({
          id: "ses_created",
          projectID: "proj_test",
          directory,
          title: "created",
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        })
      }
      // session.prompt posts to /session/:id/message in this sdk generation
      if (/^\/session\/[^/]+\/(message|command|shell)$/.test(url.pathname)) return json({})
    }
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname === "/config/providers")
      return json({
        providers: [
          {
            id: "p1",
            name: "Provider One",
            source: "env",
            env: ["P1_API_KEY"],
            options: {},
            models: {
              m1: {
                id: "m1",
                providerID: "p1",
                api: { id: "m1", url: "https://example.com", npm: "@ai-sdk/test" },
                name: "Model One",
                capabilities: {
                  temperature: true,
                  reasoning: false,
                  attachment: false,
                  toolcall: true,
                  input: { text: true, audio: false, image: false, video: false, pdf: false },
                  output: { text: true, audio: false, image: false, video: false, pdf: false },
                  interleaved: false,
                },
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: 128000, output: 4096 },
                status: "active",
                options: {},
                headers: {},
                release_date: "2025-01-01",
              },
            },
          },
        ],
        default: { p1: "m1" },
      })
    return base.fetch(req)
  }) as typeof fetch

  let promptRef: PromptRef | undefined

  function Probe(props: { ready: (ctx: Probed) => void }) {
    const dialog = useDialog()
    const toast = useToast()
    const local = useLocal()
    onMount(() => props.ready({ dialog, toast, local }))
    return <box />
  }

  function Harness(props: { ready: (ctx: Probed) => void }) {
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
        <ExitProvider exit={() => {}}>
          <OpencodeKeymapProvider keymap={keymap}>
            <ArgsProvider>
              <KVProvider>
                <ToastProvider>
                  <RouteProvider>
                    <TuiConfigProvider config={resolvedConfig}>
                      <SDKProvider url="http://test" directory={directory} events={eventSource()} fetch={fetcher}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <SyncProvider>
                              <DataProvider>
                                <ThemeProvider mode="dark">
                                  <LocalProvider>
                                    <PromptStashProvider>
                                      <DialogProvider>
                                        <FrecencyProvider>
                                          <PromptHistoryProvider>
                                            <EditorContextProvider integration={{}}>
                                              <LocationProvider>
                                                <Probe ready={props.ready} />
                                                <box flexDirection="column" flexGrow={1}>
                                                  <Prompt sessionID={input.sessionID} ref={(r) => (promptRef = r)} />
                                                </box>
                                                <Toast />
                                              </LocationProvider>
                                            </EditorContextProvider>
                                          </PromptHistoryProvider>
                                        </FrecencyProvider>
                                      </DialogProvider>
                                    </PromptStashProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </DataProvider>
                            </SyncProvider>
                          </ProjectProvider>
                        </PermissionProvider>
                      </SDKProvider>
                    </TuiConfigProvider>
                  </RouteProvider>
                </ToastProvider>
              </KVProvider>
            </ArgsProvider>
          </OpencodeKeymapProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  let ready!: (ctx: Probed) => void
  const mounted = new Promise<Probed>((resolve) => (ready = resolve))
  const app = await testRender(() => <Harness ready={ready} />, { kittyKeyboard: true })
  const ctx = await mounted

  async function prompt() {
    await wait(() => promptRef !== undefined)
    return promptRef!
  }

  return {
    app,
    ctx,
    posted,
    frame() {
      return app.captureCharFrame()
    },
    async modelReady() {
      await wait(() => ctx.local.agent.current() !== undefined && ctx.local.model.current() !== undefined)
    },
    async typeAndSubmit(value: string) {
      const ref = await prompt()
      ref.set({ input: value, parts: [] })
      // A stash-restored slash token leaves the autocomplete visible; its
      // hide() then deletes the just-set text on the next content flush.
      // Re-setting after the flush lands with the autocomplete hidden.
      await Bun.sleep(20)
      if (ref.current.input !== value) ref.set({ input: value, parts: [] })
      ref.submit()
    },
    composerText() {
      // promptRef is guaranteed to exist after typeAndSubmit awaited prompt()
      return promptRef?.current.input
    },
    asked(index: number) {
      return ask.mock.calls[index]?.[1]
    },
    usageToastShown() {
      return ctx.toast.currentToast?.message.includes("ask a side question") === true
    },
    posts(suffix: string) {
      return posted.filter((call) => call.pathname === suffix || call.pathname.endsWith(`/${suffix}`))
    },
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("/btw hello in a session asks the side question and clears the composer", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path, sessionID: "ses_test" })
  try {
    await tui.typeAndSubmit("/btw hello")
    await wait(() => ask.mock.calls.length === 1)
    expect(tui.asked(0)).toEqual({ sessionID: "ses_test", question: "hello" })
    await wait(() => tui.composerText() === "")
    expect(tui.composerText()).toBe("")
    expect(tui.posted).toHaveLength(0)
    expect(read.mock.calls).toHaveLength(0)
    expect(openBtwHistory.mock.calls).toHaveLength(0)
    expect(tui.usageToastShown()).toBe(false)
  } finally {
    await tui.cleanup()
  }
})

test("bare /btw with history entries opens the inline history browser", async () => {
  await using tmp = await tmpdir()
  read.mockImplementation(() => Promise.resolve([{ ts: 1, sessionID: "ses_test", q: "q", a: "a", model: "p1/m1" }]))
  const tui = await mount({ root: tmp.path, sessionID: "ses_test" })
  try {
    await tui.typeAndSubmit("/btw")
    await wait(() => openBtwHistory.mock.calls.length === 1)
    expect(openBtwHistory.mock.calls[0]?.[0]).toHaveProperty("dialog")
    expect(openBtwHistory.mock.calls[0]?.[0]).toHaveProperty("sessionID", "ses_test")
    expect(read.mock.calls).toHaveLength(1)
    expect(read.mock.calls[0]?.[0]).toBe("ses_test")
    expect(ask.mock.calls).toHaveLength(0)
    expect(tui.usageToastShown()).toBe(false)
    expect(tui.composerText()).toBe("/btw")
    expect(tui.posted).toHaveLength(0)
  } finally {
    await tui.cleanup()
  }
})

test("bare /btw with empty history shows usage and keeps the composer", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path, sessionID: "ses_test" })
  try {
    await tui.typeAndSubmit("/btw")
    await wait(() => tui.usageToastShown())
    expect(read.mock.calls).toHaveLength(1)
    expect(openBtwHistory.mock.calls).toHaveLength(0)
    expect(ask.mock.calls).toHaveLength(0)
    expect(tui.composerText()).toBe("/btw")
    expect(tui.posted).toHaveLength(0)
  } finally {
    await tui.cleanup()
  }
})

test("/btw hello on home shows usage and never creates a session", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path })
  try {
    await tui.typeAndSubmit("/btw hi")
    await wait(() => tui.usageToastShown())
    expect(ask.mock.calls).toHaveLength(0)
    expect(read.mock.calls).toHaveLength(0)
    expect(tui.posted).toHaveLength(0)
    await Bun.sleep(100)
    expect(tui.posted.filter((call) => call.pathname === "/session")).toHaveLength(0)
    expect(tui.composerText()).toBe("/btw hi")
  } finally {
    await tui.cleanup()
  }
})

test("btw hello without a slash submits a normal prompt", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path, sessionID: "ses_test" })
  try {
    await tui.modelReady()
    await tui.typeAndSubmit("btw hello")
    await wait(() => tui.posts("message").length === 1)
    const body = tui.posts("message")[0]?.body as { parts?: { type: string; text?: string }[] }
    expect(body.parts?.some((part) => part.type === "text" && part.text === "btw hello")).toBe(true)
    expect(ask.mock.calls).toHaveLength(0)
    expect(tui.usageToastShown()).toBe(false)
    expect(tui.composerText()).toBe("")
  } finally {
    await tui.cleanup()
  }
})

test("/btw x in shell mode routes to session.shell without interception", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path, sessionID: "ses_test" })
  try {
    await tui.modelReady()
    await wait(() => tui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    tui.app.mockInput.pressKey("!")
    await wait(() => tui.frame().includes("Shell"))
    await tui.typeAndSubmit("/btw x")
    await wait(() => tui.posts("shell").length === 1)
    const body = tui.posts("shell")[0]?.body as { command?: string }
    expect(body.command).toBe("/btw x")
    expect(ask.mock.calls).toHaveLength(0)
    expect(read.mock.calls).toHaveLength(0)
    expect(tui.posts("message")).toHaveLength(0)
  } finally {
    await tui.cleanup()
  }
})

test("hello /btw submits a normal prompt", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path, sessionID: "ses_test" })
  try {
    await tui.modelReady()
    await tui.typeAndSubmit("hello /btw")
    await wait(() => tui.posts("message").length === 1)
    const body = tui.posts("message")[0]?.body as { parts?: { type: string; text?: string }[] }
    expect(body.parts?.some((part) => part.type === "text" && part.text === "hello /btw")).toBe(true)
    expect(ask.mock.calls).toHaveLength(0)
    expect(read.mock.calls).toHaveLength(0)
    expect(tui.usageToastShown()).toBe(false)
  } finally {
    await tui.cleanup()
  }
})

test("/btw with a multiline question asks with both lines", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path, sessionID: "ses_test" })
  try {
    await tui.typeAndSubmit("/btw q1\nq2")
    await wait(() => ask.mock.calls.length === 1)
    expect(tui.asked(0)).toEqual({ sessionID: "ses_test", question: "q1\nq2" })
    await wait(() => tui.composerText() === "")
    expect(tui.posted).toHaveLength(0)
  } finally {
    await tui.cleanup()
  }
})

test("/BTW matches case-insensitively", async () => {
  await using tmp = await tmpdir()
  const tui = await mount({ root: tmp.path, sessionID: "ses_test" })
  try {
    await tui.typeAndSubmit("/BTW Wassup")
    await wait(() => ask.mock.calls.length === 1)
    expect(tui.asked(0)).toEqual({ sessionID: "ses_test", question: "Wassup" })
  } finally {
    await tui.cleanup()
  }
})
