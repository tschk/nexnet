import { createSignal } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { createTextAttributes } from "@opentui/core";
import { generateIdentity, connectDev } from "../dev-client";
import { navigate, identity } from "../state";
import { theme } from "../theme";

export function LoginScreen() {
  const [relay, setRelay] = createSignal("ws://localhost:4000");
  const [mode, setMode] = createSignal<"idle" | "generating" | "connecting">("idle");
  const [selectedItem, setSelectedItem] = createSignal(0);

  const items = ["Generate new identity", "Connect"];

  useKeyboard((key) => {
    if (key.name === "up") setSelectedItem((i) => Math.max(0, i - 1));
    if (key.name === "down") setSelectedItem((i) => Math.min(items.length - 1, i + 1));
    if (key.name === "return" || key.name === "enter") {
      if (selectedItem() === 0) {
        setMode("generating");
        const id = generateIdentity();
        setMode("idle");
      } else if (selectedItem() === 1 && identity()) {
        setMode("connecting");
        connectDev(relay()).then(() => {
          navigate("chatList");
        });
      }
    }
  });

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <text fg={theme.accent} attributes={createTextAttributes({ bold: true })}>{"  _   _      _ _ _       "}</text>
        <text fg={theme.accent} attributes={createTextAttributes({ bold: true })}>{" | \\ | |    | (_) |      "}</text>
        <text fg={theme.accent} attributes={createTextAttributes({ bold: true })}>{" |  \\| | ___| |_| |_ ___ "}</text>
        <text fg={theme.accent} attributes={createTextAttributes({ bold: true })}>{" | . ` |/ _ \\ | | __/ _ \\"}</text>
        <text fg={theme.accent} attributes={createTextAttributes({ bold: true })}>{" | |\\  |  __/ | | ||  __/"}</text>
        <text fg={theme.accent} attributes={createTextAttributes({ bold: true })}>{" \\_| \\_/\\___|_|_|\\__\\___|"}</text>

        <text fg={theme.textDim}> peer-to-peer chat · v0.1</text>

        <text> </text>

        {identity() ? (
          <text fg={theme.success}>{`✓ Identity: ${identity()!.publicKeyHex.slice(0, 16)}…`}</text>
        ) : (
          <text fg={theme.textDim}>No identity generated yet.</text>
        )}

        <text> </text>

        {items.map((item, i) => (
          <text fg={selectedItem() === i ? theme.textBright : theme.text}>
            {`${selectedItem() === i ? "▸" : " "} ${item}`}
          </text>
        ))}

        <text> </text>

        <box flexDirection="row" alignItems="center">
          <text fg={theme.textDim}>Relay: </text>
          <input
            value={relay()}
            onChange={(v: string) => setRelay(v)}
            placeholder="ws://host:port"
            width={30}
            backgroundColor={theme.inputBg}
            focusedBackgroundColor={theme.inputFocused}
            textColor={theme.text}
            cursorColor={theme.accent}
          />
        </box>

        {mode() === "connecting" && (
          <text fg={theme.warning}>◌ Connecting to relay…</text>
        )}
      </box>

      <box
        flexDirection="row"
        justifyContent="center"
        backgroundColor={theme.statusBg}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.textDim}>↑↓ navigate · Enter select · Ctrl+C quit</text>
      </box>
    </box>
  );
}
