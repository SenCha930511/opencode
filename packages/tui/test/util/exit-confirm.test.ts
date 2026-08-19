import { afterEach, describe, expect, test } from "bun:test"
import {
  disarmExitConfirm,
  exitConfirmArmed,
  pressExitConfirm,
  settleExitConfirmKey,
} from "../../src/util/exit-confirm"

afterEach(() => disarmExitConfirm())

describe("exit confirm arming", () => {
  test("first press arms without exiting, second press exits", () => {
    let exits = 0
    pressExitConfirm(() => exits++, 10_000)
    expect(exitConfirmArmed()).toBe(true)
    expect(exits).toBe(0)

    pressExitConfirm(() => exits++, 10_000)
    expect(exits).toBe(1)
    expect(exitConfirmArmed()).toBe(false)
  })

  test("waiting past the timeout disarms and the next press re-arms", async () => {
    let exits = 0
    pressExitConfirm(() => exits++, 20)
    expect(exitConfirmArmed()).toBe(true)

    await Bun.sleep(60)
    expect(exitConfirmArmed()).toBe(false)

    pressExitConfirm(() => exits++, 10_000)
    expect(exits).toBe(0)
    expect(exitConfirmArmed()).toBe(true)
  })

  test("settling any other key disarms", () => {
    pressExitConfirm(() => {}, 10_000)
    settleExitConfirmKey("binding-handled")
    settleExitConfirmKey("no-match")
    expect(exitConfirmArmed()).toBe(false)

    pressExitConfirm(() => {}, 10_000)
    settleExitConfirmKey("binding-handled")
    settleExitConfirmKey("binding-handled")
    expect(exitConfirmArmed()).toBe(false)
  })

  test("the confirm press itself is not treated as another key", () => {
    let exits = 0
    pressExitConfirm(() => exits++, 10_000)
    settleExitConfirmKey("binding-handled")
    expect(exitConfirmArmed()).toBe(true)

    pressExitConfirm(() => exits++, 10_000)
    settleExitConfirmKey("binding-handled")
    expect(exits).toBe(1)
  })

  test("a pending sequence keeps the armed state until it resolves", () => {
    pressExitConfirm(() => {}, 10_000)
    settleExitConfirmKey("binding-handled")
    expect(exitConfirmArmed()).toBe(true)

    settleExitConfirmKey("sequence-pending")
    expect(exitConfirmArmed()).toBe(true)

    settleExitConfirmKey("sequence-miss")
    expect(exitConfirmArmed()).toBe(false)
  })

  test("disarm resets the arming", () => {
    let exits = 0
    pressExitConfirm(() => exits++, 10_000)
    disarmExitConfirm()
    expect(exitConfirmArmed()).toBe(false)

    pressExitConfirm(() => exits++, 10_000)
    expect(exits).toBe(0)
    expect(exitConfirmArmed()).toBe(true)
  })
})
