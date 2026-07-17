import { describe, test, expect } from "bun:test";
import {
  generateMlsMember,
  mlsCreateGroup,
  mlsAddMember,
  mlsJoin,
  mlsEncrypt,
  mlsDecrypt,
  encodeKeyPackage,
  decodeKeyPackage,
  encodeWelcome,
  decodeWelcome,
} from "../mls.js";

describe("MLS (ts-mls RFC 9420)", () => {
  test("create group, add member, encrypt/decrypt", async () => {
    const aliceId = new TextEncoder().encode("alice");
    const bobId = new TextEncoder().encode("bob");
    const alice = await generateMlsMember(aliceId);
    const bob = await generateMlsMember(bobId);

    const groupId = new TextEncoder().encode("nexnet-mls-group");
    let aliceGroup = await mlsCreateGroup(groupId, alice);

    // Transport key package as wire
    const kpWire = encodeKeyPackage(bob.publicPackage);
    const bobKp = decodeKeyPackage(kpWire);

    const add = await mlsAddMember(aliceGroup, bobKp);
    aliceGroup = add.state;

    const welcomeWire = encodeWelcome(add.welcome);
    const welcome = decodeWelcome(welcomeWire);

    let bobGroup = await mlsJoin(welcome, bob, aliceGroup.ratchetTree);

    const pt = new TextEncoder().encode("hello MLS bob");
    const enc = await mlsEncrypt(aliceGroup, pt);
    aliceGroup = enc.state;

    const dec = await mlsDecrypt(bobGroup, enc.wire);
    bobGroup = dec.state;
    expect(new TextDecoder().decode(dec.plaintext)).toBe("hello MLS bob");

    // Bob replies
    const reply = await mlsEncrypt(bobGroup, new TextEncoder().encode("hi alice"));
    bobGroup = reply.state;
    const decA = await mlsDecrypt(aliceGroup, reply.wire);
    expect(new TextDecoder().decode(decA.plaintext)).toBe("hi alice");
  }, 30000);
});
