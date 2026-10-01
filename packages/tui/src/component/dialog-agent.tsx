import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { agentDisplayName, displayName } from "../util/display-name"

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: agentDisplayName(item.name),
        description: item.native ? "built-in" : item.description ? displayName(item.description) : undefined,
      }
    }),
  )

  return (
    <DialogSelect
      title="Select mode"
      current={local.agent.current()?.name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
