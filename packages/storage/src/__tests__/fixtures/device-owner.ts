import { DeviceStore } from "../../device-store.js";
import { cryptoProvider } from "@nexnet/crypto";

const [mode, directory] = process.argv.slice(2);
if (!directory) throw new Error("directory required");
const store = DeviceStore.open(directory, new Uint8Array(32).fill(77), cryptoProvider);
if (mode === "transaction") {
  store.transaction(() => {
    store.put("committed", new Uint8Array(128 * 1024).fill(9));
    store.put("uncommitted", new Uint8Array([8]));
    console.log("ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  });
} else {
  store.put("committed", new Uint8Array([4]));
  console.log("ready");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}
store.close();
