/*
FNXC:ChatRealtime 2026-09-13-23:30:
RUFU-234 falsification record for the live-overlay lane. The operator's streamed replies lost scattered
1-4 character runs and single inter-word spaces, so every candidate layer had to be ruled in or out with
evidence. `SessionEventBuffer` is the resume mechanism for the chat SSE overlay (`Last-Event-ID`), and a
reconnect gap is a plausible-sounding explanation for missing text. These tests pin why it cannot be the
layer that produced the reported holes: the buffer stores whole frames as opaque strings and its two loss
paths — ring eviction and `getEventsSince` — each remove a CONTIGUOUS run of whole frames. A frame's
payload is never sliced, so this lane can lose a whole delta or replay a whole delta, but it cannot delete
one character out of the middle of a word. Pinning the falsified shape here is what stops the next
investigator from re-litigating the buffer.
*/
import { describe, expect, it } from "vitest";
import { SessionEventBuffer } from "../sse-buffer.js";

describe("SessionEventBuffer — gap shape cannot produce scattered character loss (RUFU-234)", () => {
  it("ring eviction drops the oldest contiguous run of whole frames and leaves surviving payloads byte-intact", () => {
    const buffer = new SessionEventBuffer(3);
    const frames = ["Hel", "lo", " ", "wor", "ld"];
    for (const frame of frames) buffer.push("text", frame);

    // Capacity 3 keeps the newest three frames. The lost span is a contiguous prefix, and every
    // surviving frame is still exactly what was pushed — no character was removed from inside one.
    const replayed = buffer.getEventsSince(0).map((event) => event.data);
    expect(replayed).toEqual([" ", "wor", "ld"]);
    expect(replayed.join("")).toBe(" world");
  });

  it("Last-Event-ID resume returns a contiguous tail and never edits a frame's text", () => {
    const buffer = new SessionEventBuffer(100);
    const frames = ["Reš", "tar", "tuj", " ", "použit", "ý"];
    const ids = frames.map((frame) => buffer.push("text", frame));

    // Reconnecting from a mid-stream id yields the contiguous tail after that id.
    expect(buffer.getEventsSince(ids[2]!).map((event) => event.data)).toEqual([" ", "použit", "ý"]);
    // With no cursor the whole buffered run replays intact.
    expect(buffer.getEventsSince(Number.NaN).map((event) => event.data)).toEqual(frames);
    expect(buffer.getEventsSince(Number.NaN).map((event) => event.data).join("")).toBe("Reštartuj použitý");
  });

  it("an already-acknowledged cursor yields no frames rather than a truncated frame", () => {
    const buffer = new SessionEventBuffer(100);
    const lastId = buffer.push("text", "healthy");
    expect(buffer.getEventsSince(lastId)).toEqual([]);
  });
});
