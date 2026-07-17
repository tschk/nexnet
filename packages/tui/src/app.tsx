import { screen } from "./state";
import { LoginScreen } from "./screens/login";
import { ChatListScreen } from "./screens/chat-list";
import { DmViewScreen } from "./screens/dm-view";
import { RoomViewScreen } from "./screens/room-view";
import { DiscoverScreen } from "./screens/discover";
import { theme } from "./theme";

export function App() {
  const activeScreen = () => {
    switch (screen()) {
      case "chatList":
        return <ChatListScreen />;
      case "dm":
        return <DmViewScreen />;
      case "room":
        return <RoomViewScreen />;
      case "discover":
        return <DiscoverScreen />;
      default:
        return <LoginScreen />;
    }
  };

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
      {activeScreen()}
    </box>
  );
}
