import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { append, __setStateDir } from "../../src/prompt/btw-history.impl"
import type { DialogContext } from "../../src/ui/dialog"
import type { ToastContext } from "../../src/ui/toast"

// Query-busted URL on purpose: a sibling test file mocks ../../src/component/dialog-btw
// by exact path, and which module this test's imports resolve to must not depend on
// in-process load order (mock.restore() does not undo mock.module).
const { btwSessionCommand, DialogBtw } = (await import(
  "../../src/component/dialog-btw" + "?real"
)) as typeof import("../../src/component/dialog-btw")

const USAGE = "/btw <question> - ask a side question about the current session"

function deps(input: { sessionID?: string; messages: string[]; cleared: boolean[] }) {
  const toast = {
    show: (toast: { message: string }) => {
      input.messages.push(toast.message)
    },
  } as unknown as ToastContext
  const dialog = {
    clear: () => {
      input.cleared.push(true)
    },
  } as unknown as DialogContext
  return { sessionID: () => input.sessionID, dialog, toast }
}

beforeEach(() => {
  DialogBtw.dismiss()
})

afterEach(() => {
  __setStateDir(undefined)
})

test("registers session.btw as a palette slash command named btw", () => {
  const command = btwSessionCommand(deps({ messages: [], cleared: [] }))
  expect(command).toMatchObject({
    name: "session.btw",
    title: "Ask a side question",
    category: "Session",
    slashName: "btw",
  })
  expect(command).not.toHaveProperty("slashAliases")
})

test("run without an active session shows the usage toast", async () => {
  const messages: string[] = []
  const cleared: boolean[] = []
  await btwSessionCommand(deps({ messages, cleared })).run()
  expect(messages).toEqual([USAGE])
  expect(cleared).toHaveLength(0)
  expect(DialogBtw.active()).toBe(false)
})

test("run with an empty history shows the usage toast", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  __setStateDir(state)
  const messages: string[] = []
  const cleared: boolean[] = []
  await btwSessionCommand(deps({ sessionID: "ses_test", messages, cleared })).run()
  expect(messages).toEqual([USAGE])
  expect(cleared).toHaveLength(0)
  expect(DialogBtw.active()).toBe(false)
})

test("run with history entries clears dialogs and opens the inline history browser", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  __setStateDir(state)
  await append({ ts: 1, sessionID: "ses_test", q: "stored question", a: "stored answer", model: "p1/m1" })
  const messages: string[] = []
  const cleared: boolean[] = []
  await btwSessionCommand(deps({ sessionID: "ses_test", messages, cleared })).run()
  expect(messages).toHaveLength(0)
  expect(cleared).toHaveLength(1)
  const start = Date.now()
  while (!DialogBtw.active()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for the history browser")
    await Bun.sleep(10)
  }
  DialogBtw.dismiss()
})
