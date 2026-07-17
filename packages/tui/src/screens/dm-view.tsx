import { For, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { conversations, activePeer, navigate } from "../state";
import { sendDevMessage } from "../dev-client";
import { theme, hexToShort } from "../theme";
import { StatusBar } from "../components/status-bar";
import { MessageBubble } from "../components/message-bubble";
import { InputBar } from "../components/input-bar";

export function DmViewScreen() {
  const peerHex = () => activePeer();
  const conversation = () => conversations().find((c) => c.peerHex === peerHex());
  const messages = () => conversation()?.messages ?? [];

  useKeyboard((key) => {
    if (key.name === "escape") {
      navigate("chatList");
    }
  });

  function handleSend(text: string) {
    const peer = peerHex();
    if (!peer) return;
    sendDevMessage(peer, text);
  }

  const peerName = () => {
    const conv = conversation();
    if (conv) return conv.peerName;
    const hex = peerHex();
    return hex ? hexToShort(hex) : "unknown";
  };

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
          <text fg={theme.accent} bold>{peerName()}</text>
          <text fg={theme.textDim}> · DM</text>
        </text>
        <text fg={theme.textDim}>Esc back</text>
      </box>

      <box flexDirection="column" flexGrow paddingLeft={0} paddingRight={0} paddingTop={1}>
        <For each={messages()}>
          {(msg) => <MessageBubble message={msg} />}
        </For>
        <Show when={messages().length === 0}>
          <text fg={theme.textDim}>No messages yet. Say hello!</text>
        </Show>
      </box>

      <InputBar onSend={handleSend} placeholder="type a message…" />
      <StatusBar />
    </box>
  );
}

