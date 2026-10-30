import { expect, test } from "bun:test";
import { parseAgentEnvelope, parseAgentExecution } from "../agent-envelope.js";

test("agent wire v1 rejects ambiguous variants, versions, non-JSON values, excess depth and oversize input", () => {
  const request = {
    version: 1,
    kind: "request",
    correlationId: "test-1",
    capability: "sum",
    acceptBefore: 1234,
    input: { a: 8, b: 3 },
  } as const;
  expect(parseAgentEnvelope(request)).toEqual(request);
  let nested: unknown = 0;
  for (let i = 0; i < 14; i++) nested = [nested];
  for (const invalid of [
    { ...request, version: 2 },
    { ...request, correlationId: "a:b" },
    { ...request, acceptBefore: 1.5 },
    { ...request, deadline: 5 },
    { ...request, input: undefined },
    { ...request, input: nested },
    { ...request, input: "ü".repeat(2050) },
    { ...request, input: NaN },
    { version: 1, kind: "result", correlationId: "x", status: "accepted", value: 5 },
    { version: 1, kind: "error", correlationId: "x", stage: "timeout", code: "timeout", message: "" },
  ])
    expect(() => parseAgentEnvelope(invalid)).toThrow("invalid_envelope");
  expect(() => parseAgentExecution({ state: "unknown" })).toThrow();
  expect(() => parseAgentExecution({ state: "accepted" })).toThrow();
  expect(parseAgentExecution({ state: "accepted", outcome: "not_reported" })).toEqual({
    state: "accepted",
    outcome: "not_reported",
  });
});
