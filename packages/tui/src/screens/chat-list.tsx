import { createSignal, For, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { conversations, rooms, setActivePeer, setActiveRoom, navigate, type Conversation, type Room } from "../state";
import { theme, formatTime, truncate } from "../theme";
import { StatusBar } from "../components/status-bar";

export function ChatListScreen() {
  const [selected, setSelected] = createSignal(0);

  // Flatten selectable items (DMs then rooms)
  function selectableItems() {
    const result: Array<{ kind: "dm"; conv: Conversation } | { kind: "room"; room: Room }> = [];
    for (const c of conversations()) result.push({ kind: "dm", conv: c });
    for (const r of rooms()) result.push({ kind: "room", room: r });
    return result;
  }

  useKeyboard((key) => {
    const items = selectableItems();
    if (items.length === 0) return;

    if (key.name === "up") setSelected((i) => Math.max(0, i - 1));
    if (key.name === "down") setSelected((i) => Math.min(items.length - 1, i + 1));
    if (key.name === "return" || key.name === "enter") {
      const item = items[selected()];
      if (!item) return;
      if (item.kind === "dm") {
        setActivePeer(item.conv.peerHex);
        navigate("dm");
      } else {
        setActiveRoom(item.room.id);
        navigate("room");
      }
    }
    if (key.name === "n") navigate("discover");
  });

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box
        flexDirection="row"
        justifyContent="space-between"
        backgroundColor={theme.headerBg}
        paddingLeft={1}
        paddingRight={1}
      >
        <text>
          <text fg={theme.accent} bold>Nexnet</text>
          <text fg={theme.textDim}> — chat list</text>
        </text>
        <text fg={theme.textDim}>n new · Enter open</text>
      </box>

      <box flexDirection="column" flexGrow paddingLeft={1} paddingRight={1} paddingTop={1}>
        <Show when={conversations().length > 0}>
          <text>
            <text fg={theme.textDim} bold>Direct Messages</text>
          </text>
          <For each={conversations()}>
            {(conv, idx) => {
              const isSel = () => idx() === selected();
              const lastMsg = () => conv.messages[conv.messages.length - 1];
              return (
                <box flexDirection="row" justifyContent="space-between">
                  <text>
                    <text fg={isSel() ? theme.accent : theme.textDim}>
                      {isSel() ? "▸ " : "  "}
                    </text>
                    <text fg={conv.online ? theme.online : theme.textDim}>● </text>
                    <text fg={isSel() ? theme.textBright : theme.text}>
                      {truncate(conv.peerName, 20)}
                    </text>
                    <text fg={theme.textDim}>
                      {" "}
                      {lastMsg() ? truncate(lastMsg()!.text, 36) : "no messages"}
                    </text>
                  </text>
                  <text fg={theme.textDim}>
                    {lastMsg() ? formatTime(lastMsg()!.createdAt) : ""}
                  </text>
                </box>
              );
            }}
          </For>
        </Show>

        <Show when={rooms().length > 0}>
          <text>
            <text fg={theme.textDim} bold>Rooms</text>
          </text>
          <For each={rooms()}>
            {(room, idx) => {
              const offset = () => conversations().length;
              const isSel = () => idx() + offset() === selected();
              return (
                <box flexDirection="row" justifyContent="space-between">
                  <text>
                    <text fg={isSel() ? theme.accent : theme.textDim}>
                      {isSel() ? "▸ " : "  "}
                    </text>
                    <text fg={theme.accent}># </text>
                    <text fg={isSel() ? theme.textBright : theme.text}>{room.name}</text>
                    <text fg={theme.textDim}> ({room.memberCount})</text>
                  </text>
                </box>
              );
            }}
          </For>
        </Show>

        <Show when={conversations().length === 0 && rooms().length === 0}>
          <text fg={theme.textDim}>No conversations yet. Press n to find users.</text>
        </Show>
      </box>

      <StatusBar />
    </box>
  );
}
