import { createSignal, For, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { createTextAttributes } from "@opentui/core";
import { discoveredUsers, navigate, setActivePeer, type DiscoveredUser } from "../state";
import { theme, hexToShort, truncate } from "../theme";
import { StatusBar } from "../components/status-bar";

export function DiscoverScreen() {
  const [selected, setSelected] = createSignal(0);
  const [filterText, setFilterText] = createSignal("");

  const filtered = () => {
    const query = filterText().toLowerCase();
    const users = discoveredUsers();
    if (!query) return users;
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(query) ||
        u.bio.toLowerCase().includes(query) ||
        u.interests.some((t) => t.toLowerCase().includes(query)),
    );
  };

  useKeyboard((key) => {
    const items = filtered();
    if (key.name === "escape") {
      navigate("chatList");
      return;
    }
    if (key.name === "up") setSelected((i) => Math.max(0, i - 1));
    if (key.name === "down") setSelected((i) => Math.min(items.length - 1, i + 1));
    if (key.name === "return" || key.name === "enter") {
      const user = items[selected()];
      if (user) {
        setActivePeer(user.identityHex);
        navigate("dm");
      }
    }
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
        <text fg={theme.accent} attributes={createTextAttributes({ bold: true })}>Discover — find people</text>
        <text fg={theme.textDim}>Esc back · Enter message</text>
      </box>

      <box flexDirection="row" alignItems="center" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <text fg={theme.textDim}>Search: </text>
        <input
          placeholder="interest, language, name…"
          value={filterText()}
          onInput={(v: string) => {
            setFilterText(v);
            setSelected(0);
          }}
          width={40}
          backgroundColor={theme.inputBg}
          focusedBackgroundColor={theme.inputFocused}
          textColor={theme.text}
          cursorColor={theme.accent}
        />
      </box>

      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
        <For each={filtered()}>
          {(user, idx) => {
            const isSel = () => idx() === selected();
            return (
              <box flexDirection="column" paddingBottom={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={isSel() ? theme.textBright : theme.text} attributes={createTextAttributes({ bold: true })}>
                    {`${isSel() ? "▸" : " "} ${user.online ? "●" : "○"} ${user.username} (${hexToShort(user.identityHex)})`}
                  </text>
                </box>
                <text fg={theme.textDim}>{"    "}{truncate(user.bio, 60)}</text>
                <text fg={theme.accentDim}>{"    "}{user.interests.join(", ")}</text>
              </box>
            );
          }}
        </For>
        <Show when={filtered().length === 0}>
          <text fg={theme.textDim}>No users match your search.</text>
        </Show>
      </box>

      <StatusBar />
    </box>
  );
}
