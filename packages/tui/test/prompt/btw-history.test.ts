import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
// Import the impl module directly: dialog-btw.test.tsx mocks the public btw-history
// path process-globally, which would silently no-op append() for this file.
import { __setStateDir, append, read, type BtwEntry } from "../../src/prompt/btw-history.impl"

const entry = (over: Partial<BtwEntry> = {}): BtwEntry => ({
  ts: 1,
  sessionID: "ses_a",
  q: "question",
  a: "answer",
  model: "p/m",
  ...over,
})

async function useTmpState() {
  const tmp = await tmpdir()
  __setStateDir(tmp.path)
  return tmp
}

afterEach(() => {
  __setStateDir(undefined)
})

test("roundtrip: appended entries read back most-recent-first", async () => {
  await using tmp = await useTmpState()
  expect(tmp.path).toBeTruthy()
  await append(entry({ ts: 1, q: "first" }))
  await append(entry({ ts: 2, q: "second" }))
  const result = await read("ses_a")
  expect(result.map((x) => x.q)).toEqual(["second", "first"])
  expect(result[0]).toMatchObject({ ts: 2, a: "answer", model: "p/m" })
})

test("cap: file exceeding 1200 lines is pruned to the newest 1000, oldest dropped", async () => {
  await using tmp = await useTmpState()
  const file = path.join(tmp.path, "btw-history.jsonl")
  const seeded = Array.from({ length: 1205 }, (_, i) => JSON.stringify(entry({ ts: i, q: `q${i}` }))).join("\n") + "\n"
  await Bun.write(file, seeded)

  await append(entry({ ts: 9999, q: "newest" }))

  const lines = (await Bun.file(file).text()).split("\n").filter(Boolean)
  expect(lines.length).toBeLessThanOrEqual(1000)
  const parsed = lines.map((line) => JSON.parse(line) as BtwEntry)
  expect(parsed.at(-1)?.q).toBe("newest")
  expect(parsed.some((x) => x.q === "q0")).toBe(false)
  expect(parsed.some((x) => x.q === "q205")).toBe(false)
  expect(parsed.some((x) => x.q === "q206")).toBe(true)
})

test("malformed input: corrupt lines and entries missing fields are skipped", async () => {
  await using tmp = await useTmpState()
  const good = entry({ ts: 5, q: "good" })
  const lines = [
    "not json at all",
    JSON.stringify({ ts: "nope", sessionID: 1 }),
    JSON.stringify({ sessionID: "ses_a", q: "missing ts/a/model" }),
    JSON.stringify([1, 2, 3]),
    "",
    JSON.stringify(good),
  ].join("\n")
  await Bun.write(path.join(tmp.path, "btw-history.jsonl"), lines + "\n")

  expect(await read("ses_a")).toEqual([good])
})

test("sessionID filter: only entries for the requested session are returned, most-recent-first", async () => {
  await using tmp = await useTmpState()
  await append(entry({ ts: 1, sessionID: "ses_a", q: "a1" }))
  await append(entry({ ts: 2, sessionID: "ses_b", q: "b1" }))
  await append(entry({ ts: 3, sessionID: "ses_a", q: "a2" }))
  await append(entry({ ts: 4, sessionID: "ses_b", q: "b2" }))

  expect((await read("ses_b")).map((x) => x.q)).toEqual(["b2", "b1"])
  expect((await read("ses_a")).map((x) => x.q)).toEqual(["a2", "a1"])
  expect(await read("ses_missing")).toEqual([])
})

test("missing file: read returns [] without throwing", async () => {
  await using tmp = await useTmpState()
  expect(await read("ses_a")).toEqual([])
})

test("best-effort: append to an unwritable state dir resolves without throwing", async () => {
  await using tmp = await useTmpState()
  const locked = path.join(tmp.path, "locked")
  await mkdir(locked)
  await chmod(locked, 0o444)
  try {
    __setStateDir(locked)
    await append(entry())
    expect(await read("ses_a")).toEqual([])
  } finally {
    await chmod(locked, 0o755)
  }
})
