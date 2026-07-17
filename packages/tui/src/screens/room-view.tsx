import { For, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { createTextAttributes } from "@opentui/core";
import { rooms, activeRoom, navigate } from "../state";
import { sendDevRoomMessage } from "../dev-client";
import { theme } from "../theme";
import { StatusBar } from "../components/status-bar";
import { MessageBubble } from "../components/message-bubble";
import { InputBar } from "../components/input-bar";

export function RoomViewScreen() {
  const roomId = () => activeRoom();
  const room = () => rooms().find((r) => r.id === roomId());
  const messages = () => room()?.messages ?? [];

  useKeyboard((key) => {
    if (key.name === "escape") {
      navigate("chatList");
    }
  });

  function handleSend(text: string) {
    const id = roomId();
    if (!id) return;
    sendDevRoomMessage(id, text);
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box
        flexDirection="row"
        justifyContent="space-between"
        backgroundColor={theme.headerBg}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.accent} attributes={createTextAttributes({ bold: true })}>
          {`${room()?.name ?? "Room"} · ${room()?.memberCount ?? 0} members`}
        </text>
        <text fg={theme.textDim}>Esc back</text>
      </box>

      <box flexDirection="column" flexGrow={1} paddingLeft={0} paddingRight={0} paddingTop={1}>
        <For each={messages()}>
          {(msg) => <MessageBubble message={msg} />}
        </For>
        <Show when={messages().length === 0}>
          <text fg={theme.textDim}>No messages in this room yet.</text>
        </Show>
      </box>

      <InputBar onSend={handleSend} placeholder="type a room message…" />
      <StatusBar />
    </box>
  );
}
