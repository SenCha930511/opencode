import { DialogSelect } from "../../ui/dialog-select"
import { useRoute } from "../../context/route"

import { useToast } from "../../ui/toast"
import { useSync } from "../../context/sync"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()
  const sync = useSync()
  const toast = useToast()

  const openSubagent = (dialog: any) => {
    const session = sync.session.get(props.sessionID)
    const msgs = sync.data.message[props.sessionID] ?? []
    if (!session || msgs.length === 0) {
      toast.show({ variant: "warning", message: "Subagent has no output to display" })
      dialog.clear()
      return
    }
    route.navigate({
      type: "session",
      sessionID: props.sessionID,
    })
    dialog.clear()
  }

  return (
    <DialogSelect
      title="Subagent Actions"
      options={[
        {
          title: "Open",
          value: "subagent.view",
          description: "the subagent's session",
          onSelect: openSubagent,
        },
        ]}
      />
  )
}
