import { connStatus, identity } from "../state";
import { theme, hexToShort } from "../theme";

export function StatusBar() {
  const statusColor = () => {
    switch (connStatus()) {
      case "connected":
        return theme.success;
      case "connecting":
        return theme.warning;
      default:
        return theme.error;
    }
  };

  const statusText = () => {
    switch (connStatus()) {
      case "connected":
        return "● online";
      case "connecting":
        return "◌ connecting…";
      default:
        return "○ offline";
    }
  };

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      backgroundColor={theme.statusBg}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={statusColor()}>{statusText()}</text>
      <text fg={theme.textDim}>
        {identity()?.username ? identity()!.username : hexToShort(identity()?.publicKeyHex ?? "—")}
      </text>
    </box>
  );
}
