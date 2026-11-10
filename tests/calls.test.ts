import test from "node:test";
import assert from "node:assert/strict";
import { videoTransceiver } from "../src/lib/calls";

function fakeTransceiver(mid: string | null, kind: string): RTCRtpTransceiver {
  return { mid, sender: { track: null }, receiver: { track: { kind } } } as unknown as RTCRtpTransceiver;
}
function peer(transceivers: RTCRtpTransceiver[]): RTCPeerConnection {
  return { getTransceivers: () => transceivers } as unknown as RTCPeerConnection;
}

test("screen sharing uses the negotiated video transceiver, not an unassociated one", () => {
  const audio = fakeTransceiver("0", "audio");
  const unassociated = fakeTransceiver(null, "video");
  const negotiated = fakeTransceiver("1", "video");
  assert.equal(videoTransceiver(peer([audio, unassociated, negotiated])), negotiated);
  assert.equal(videoTransceiver(peer([audio, unassociated])), unassociated);
  assert.equal(videoTransceiver(peer([audio])), undefined);
});
