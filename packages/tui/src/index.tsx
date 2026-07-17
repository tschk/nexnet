import { render } from "@opentui/solid";
import { App } from "./app";

render(() => <App />, {
  exitOnCtrlC: true,
  targetFps: 30,
});
