import { createSignal, onMount } from "solid-js";
import { theme } from "../theme";

export function InputBar(props: { onSend: (text: string) => void; placeholder?: string }) {
  let inputRef: any;

  function handleSend(value: string) {
    const text = value.trim();
    if (!text) return;
    props.onSend(text);
    // Clear input after send
    if (inputRef) inputRef.value = "";
  }

  return (
    <box
      flexDirection="row"
      alignItems="center"
      backgroundColor={theme.inputBg}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.accent}>{">"} </text>
      <input
        ref={inputRef}
        placeholder={props.placeholder ?? "type a message…"}
        on:enter={handleSend}
        width={80}
        backgroundColor={theme.inputBg}
        focusedBackgroundColor={theme.inputFocused}
        textColor={theme.text}
        cursorColor={theme.accent}
      />
    </box>
  );
}
