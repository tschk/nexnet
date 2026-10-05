import { DevChainClient } from "@nexnet/client/chain-stub";
import { ConfigError, configFromEnv } from "./config.js";
import { Gateway } from "./gateway.js";

try {
  const config = configFromEnv(process.env);
  const chain = new DevChainClient(config.stateDir ? `${config.stateDir}/chain.json` : undefined);
  const port = Number.parseInt(process.env.PORT ?? "8788", 10);
  const hostname = process.env.HOST ?? "127.0.0.1";
  const handle = new Gateway(config, chain).listen(port, hostname);
  console.log(`nexnet gateway on ${handle.url} (audience ${config.audience}, dev-chain)`);
  console.log(config.ownerIdentity ? "updates: owner configured" : "updates: closed (no NEXNET_OWNER_IDENTITY)");
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
