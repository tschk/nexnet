import type { ChatMessage } from "../state";
import { createTextAttributes } from "@opentui/core";
import { theme, formatTime } from "../theme";

export function MessageBubble(props: { message: ChatMessage }) {
  const m = () => props.message;

  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={m().own ? theme.accent : theme.success} attributes={createTextAttributes({ bold: true })}>
          {`${m().senderName} ${formatTime(m().createdAt)}`}
        </text>
        <text fg={m().delivered ? theme.success : theme.textDim}>
          {m().delivered ? "✓" : "◌"}
        </text>
      </box>
      <text fg={m().own ? theme.textBright : theme.text}>{m().text}</text>
    </box>
  );
}
