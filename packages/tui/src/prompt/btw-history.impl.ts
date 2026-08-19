import path from "path"
import { rename } from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { appendText, readText } from "../util/persistence"

export interface BtwEntry {
  ts: number
  sessionID: string
  q: string
  a: string
  model: string
}

// The file is re-read on every dialog open, so it stays small: once it exceeds
// MAX_FILE_LINES it is rewritten keeping only the newest RETAINED_LINES entries.
const MAX_FILE_LINES = 1200
const RETAINED_LINES = 1000

let stateDir: string | undefined

/** Test-only hook: redirect the history file into a temp state dir. */
export function __setStateDir(dir: string | undefined) {
  stateDir = dir
}

function target() {
  return path.join(stateDir ?? Global.Path.state, "btw-history.jsonl")
}

export async function append(entry: BtwEntry): Promise<void> {
  try {
    await appendText(target(), JSON.stringify(entry) + "\n")
    await prune(target())
  } catch {
    // Best-effort: callers fire-and-forget, so losing a history row must never break /btw.
  }
}

export async function read(sessionID: string): Promise<BtwEntry[]> {
  const text = await readText(target()).catch(() => "")
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        return undefined
      }
    })
    .filter((entry): entry is BtwEntry => isBtwEntry(entry) && entry.sessionID === sessionID)
    .reverse()
}

async function prune(file: string) {
  const lines = (await readText(file).catch(() => "")).split("\n").filter(Boolean)
  if (lines.length <= MAX_FILE_LINES) return
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, lines.slice(-RETAINED_LINES).join("\n") + "\n")
  await rename(temporary, file)
}

function isBtwEntry(value: unknown): value is BtwEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.ts === "number" &&
    typeof entry.sessionID === "string" &&
    typeof entry.q === "string" &&
    typeof entry.a === "string" &&
    typeof entry.model === "string"
  )
}
