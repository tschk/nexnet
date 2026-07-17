import { describe, expect, test } from "bun:test";
import { parsePasskeyBridgeResponse } from "./passkey";

describe("native passkey bridge response", () => {
  test("accepts base64url registration fields", () => {
    expect(parsePasskeyBridgeResponse('{"credentialId":"AQI","attestationObject":"AwQ","clientDataJSON":"BQY"}', "register")).toEqual({
      credentialId: "AQI",
      attestationObject: "AwQ",
      clientDataJSON: "BQY",
    });
  });

  test("rejects malformed bridge data", () => {
    expect(() => parsePasskeyBridgeResponse('{"credentialId":"AQI","clientDataJSON":"BQY"}', "assert")).toThrow("authenticatorData");
  });
});
