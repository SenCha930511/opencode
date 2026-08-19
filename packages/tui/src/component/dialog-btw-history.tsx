import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { onMount } from "solid-js"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { read, type BtwEntry } from "../prompt/btw-history.impl"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

export type BtwHistoryContext = {
  dialog: DialogContext
  /** Explicit session id; when omitted, the session is resolved from the active route. */
  sessionID?: string
}

/**
 * Opens the /btw history browser. No-op when the session has no entries;
 * empty-state toasting is the submit interceptor's job.
 */
export function openBtwHistory(ctx: BtwHistoryContext): void {
  if (ctx.sessionID) {
    void openForSession(ctx.dialog, ctx.sessionID)
    return
  }
  // Callers run from the async submit path with no solid owner, so the route
  // context is only reachable from inside the dialog tree itself.
  ctx.dialog.replace(() => <ResolveBtwHistorySession />)
}

async function openForSession(dialog: DialogContext, sessionID: string) {
  const entries = await read(sessionID)
  if (entries.length === 0) return false
  dialog.replace(() => <DialogBtwHistory entries={entries} />)
  return true
}

function ResolveBtwHistorySession() {
  const dialog = useDialog()
  const route = useRoute()
  onMount(async () => {
    if (route.data.type === "session" && (await openForSession(dialog, route.data.sessionID))) return
    dialog.clear()
  })
  return <box />
}

function DialogBtwHistory(props: { entries: BtwEntry[] }) {
  const options = props.entries.map((entry): DialogSelectOption<BtwEntry> => {
    const title = entry.q.replace(/\s+/g, " ").trim()
    return {
      title,
      description: `${relative(entry.ts)} · ${entry.model}`,
      value: entry,
      onSelect: (ctx) => ctx.replace(() => <DialogBtwHistoryEntry entry={entry} />),
    }
  })
  return <DialogSelect title="/btw history" placeholder="Search side questions" options={options} />
}

// Read-only view of a stored answer. Mirrors the live /btw overlay in dialog-btw.tsx
// but never re-asks the model; entry text is data rendered through <markdown> only.
function DialogBtwHistoryEntry(props: { entry: BtwEntry }) {
  const dialog = useDialog()
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()

  onMount(() => dialog.setSize("large"))

  useBindings(() => ({
    enabled: true,
    bindings: [
      { key: "return", desc: "Dismiss side question", group: "Dialog", cmd: () => dialog.clear() },
      { key: "space", desc: "Dismiss side question", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            /btw
          </text>
          <text fg={theme.textMuted}>{props.entry.q}</text>
        </box>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox maxHeight={Math.max(8, Math.floor(dimensions().height / 2))} flexShrink={1}>
        <markdown
          syntaxStyle={syntax()}
          streaming={true}
          internalBlockMode="top-level"
          content={props.entry.a}
          tableOptions={{ style: "grid" }}
          conceal={true}
          fg={theme.markdownText}
          bg={theme.backgroundPanel}
        />
      </scrollbox>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>esc, enter, space = dismiss</text>
      </box>
    </box>
  )
}

function relative(ts: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
