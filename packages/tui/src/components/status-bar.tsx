import { connProblem, connStatus, identity } from "../state";
import { theme, hexToShort } from "../theme";

export function StatusBar() {
  const statusColor = () => {
    switch (connStatus()) {
      case "connected":
        return theme.success;
      case "connecting":
      case "reconnecting":
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
      case "reconnecting":
        return "◌ reconnecting…";
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
      {connProblem() && <text fg={theme.error}>{`⚠ ${shorten(connProblem()!, 64)}`}</text>}
      <text fg={theme.textDim}>
        {identity()?.username ? identity()!.username : hexToShort(identity()?.publicKeyHex ?? "—")}
      </text>
    </box>
  );
}

/** Keep the one-line status bar from wrapping. */
function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
