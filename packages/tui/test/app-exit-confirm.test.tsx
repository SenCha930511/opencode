/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createFetch, eventSource } from "./fixture/tui-sdk"
import { TestTuiContexts } from "./fixture/tui-environment"
import { disarmExitConfirm } from "../src/util/exit-confirm"

const DIRECTORY = "/tmp/oc-exit-confirm"

afterEach(() => disarmExitConfirm())

async function wait(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mount(input: { root: string; onExit: () => void }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, Toast },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { SDKProvider },
    { ArgsProvider },
    { PermissionProvider },
    { RouteProvider },
    { ProjectProvider },
    { SyncProvider },
    { DataProvider },
    { LocalProvider },
    { PromptStashProvider },
    { PromptHistoryProvider },
    { FrecencyProvider },
    { EditorContextProvider },
    { LocationProvider },
    { ExitProvider },
    { PromptRefProvider, usePromptRef },
    { Prompt },
    { ExitConfirmBinding },
  ] = await Promise.all([
    import("../src/ui/dialog"),
    import("../src/context/kv"),
    import("../src/context/theme"),
    import("../src/config"),
    import("../src/ui/toast"),
    import("../src/keymap"),
    import("../src/context/sdk"),
    import("../src/context/args"),
    import("../src/context/permission"),
    import("../src/context/route"),
    import("../src/context/project"),
    import("../src/context/sync"),
    import("../src/context/data"),
    import("../src/context/local"),
    import("../src/prompt/stash"),
    import("../src/prompt/history"),
    import("../src/prompt/frecency"),
    import("../src/context/editor"),
    import("../src/context/location"),
    import("../src/context/exit"),
    import("../src/context/prompt"),
    import("../src/component/prompt"),
    import("../src/app"),
  ])

  function SessionPrompt() {
    const promptRef = usePromptRef()
    return <Prompt sessionID="ses_test" ref={(r) => promptRef.set(r)} />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts cwd={DIRECTORY} paths={{ home: input.root, state, worktree: input.root }}>
        <ExitProvider exit={() => {}}>
          <OpencodeKeymapProvider keymap={keymap}>
            <ArgsProvider>
              <KVProvider>
                <ToastProvider>
                  <RouteProvider>
                    <TuiConfigProvider config={resolvedConfig}>
                      <SDKProvider
                        url="http://test"
                        directory={input.root}
                        events={eventSource()}
                        fetch={createFetch().fetch}
                      >
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
                                            <PromptRefProvider>
                                              <EditorContextProvider integration={{}}>
                                                <LocationProvider>
                                                  <box flexDirection="column">
                                                    <ExitConfirmBinding onExit={input.onExit} />
                                                    <SessionPrompt />
                                                  </box>
                                                  <Toast />
                                                </LocationProvider>
                                              </EditorContextProvider>
                                            </PromptRefProvider>
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

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  return {
    app,
    frame() {
      return app.captureCharFrame()
    },
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

function directoryRow(frame: string) {
  return frame.split("\n").findIndex((line) => line.includes(DIRECTORY))
}

test("first ctrl+c shows the confirm hint at the directory spot, second ctrl+c exits", async () => {
  await using tmp = await tmpdir()
  const exits: string[] = []
  const tui = await mount({ root: tmp.path, onExit: () => exits.push("exit") })
  try {
    await wait(() => directoryRow(tui.frame()) !== -1)
    expect(tui.frame()).not.toContain("again to quit")
    const spot = directoryRow(tui.frame())

    tui.app.mockInput.pressKey("c", { ctrl: true })
    await wait(() => tui.frame().includes("again to quit"))
    const armed = tui.frame()
    expect(armed.split("\n").findIndex((line) => line.includes("again to quit"))).toBe(spot)
    expect(armed).not.toContain(DIRECTORY)
    expect(exits).toEqual([])

    tui.app.mockInput.pressKey("c", { ctrl: true })
    await wait(() => exits.length === 1)
  } finally {
    await tui.cleanup()
  }
})

test("another key or the timeout disarms the exit confirmation", async () => {
  await using tmp = await tmpdir()
  const exits: string[] = []
  const tui = await mount({ root: tmp.path, onExit: () => exits.push("exit") })
  try {
    await wait(() => directoryRow(tui.frame()) !== -1)

    tui.app.mockInput.pressKey("c", { ctrl: true })
    await wait(() => tui.frame().includes("again to quit"))
    tui.app.mockInput.pressEscape()
    await wait(() => !tui.frame().includes("again to quit"))
    expect(exits).toEqual([])

    tui.app.mockInput.pressKey("c", { ctrl: true })
    await wait(() => tui.frame().includes("again to quit"))
    await Bun.sleep(2800)
    await wait(() => !tui.frame().includes("again to quit"))
    expect(exits).toEqual([])

    tui.app.mockInput.pressKey("c", { ctrl: true })
    await wait(() => tui.frame().includes("again to quit"))
    expect(exits).toEqual([])

    tui.app.mockInput.pressKey("c", { ctrl: true })
    await wait(() => exits.length === 1)
  } finally {
    await tui.cleanup()
  }
}, 15_000)
