import { createSignal } from "solid-js"
import type { KeyAfterReason } from "@opentui/keymap"

export const EXIT_CONFIRM_TIMEOUT = 2500

const [armed, setArmed] = createSignal(false)
let timer: ReturnType<typeof setTimeout> | undefined
// True while the key being processed ran the confirm command, so the
// key:after observer does not disarm an arming that just happened.
let confirmConsumed = false

export function exitConfirmArmed() {
  return armed()
}

export function disarmExitConfirm() {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  confirmConsumed = false
  setArmed(false)
}

export function pressExitConfirm(onExit: () => void, timeout = EXIT_CONFIRM_TIMEOUT) {
  confirmConsumed = true
  if (!armed()) {
    setArmed(true)
    timer = setTimeout(disarmExitConfirm, timeout)
    return
  }
  disarmExitConfirm()
  onExit()
}

export function settleExitConfirmKey(reason: KeyAfterReason) {
  if (confirmConsumed) {
    confirmConsumed = false
    return
  }
  // A pending sequence (e.g. <leader>) may still resolve to the confirm
  // command; disarm once it resolves to anything else.
  if (reason === "sequence-pending") return
  disarmExitConfirm()
}
