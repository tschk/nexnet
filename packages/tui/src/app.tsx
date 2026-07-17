import { Switch, Match } from "solid-js";
import { screen } from "./state";
import { LoginScreen } from "./screens/login";
import { ChatListScreen } from "./screens/chat-list";
import { DmViewScreen } from "./screens/dm-view";
import { RoomViewScreen } from "./screens/room-view";
import { DiscoverScreen } from "./screens/discover";
import { theme } from "./theme";

export function App() {
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
      <Switch>
        <Match when={screen() === "login"}>
          <LoginScreen />
        </Match>
        <Match when={screen() === "chatList"}>
          <ChatListScreen />
        </Match>
        <Match when={screen() === "dm"}>
          <DmViewScreen />
        </Match>
        <Match when={screen() === "room"}>
          <RoomViewScreen />
        </Match>
        <Match when={screen() === "discover"}>
          <DiscoverScreen />
        </Match>
      </Switch>
    </box>
  );
}
