import { describe, expect, it } from "vitest";
import { PlaybackQueue } from "./playbackQueue";

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const block = 8192;

describe("PlaybackQueue", () => {
  it("refuses audio that arrives before the stream was opened", () => {
    const q = new PlaybackQueue();
    expect(q.push("t1", 1, bytes(320))).toBe(false);
    expect(q.stats.added).toBe(0);
  });

  it("emits blocks in order once enough audio has accumulated", () => {
    const q = new PlaybackQueue();
    q.reset(24000, "t1");
    q.push("t1", 1, bytes(4096));
    expect(q.drain()).toHaveLength(0); // not a whole block yet
    q.push("t1", 2, bytes(4096));
    const out = q.drain();
    expect(out).toHaveLength(1);
    expect(out[0].pcm.byteLength).toBe(block);
    expect(out[0].rate).toBe(24000);
  });

  it("drops duplicates and never plays a frame twice", () => {
    const q = new PlaybackQueue();
    q.reset(24000, "t1");
    expect(q.push("t1", 1, bytes(block))).toBe(true);
    expect(q.push("t1", 1, bytes(block))).toBe(false);
    expect(q.push("t1", 0, bytes(block))).toBe(false);
    expect(q.stats.duplicates).toBe(2);
    const out = q.drain();
    expect(out).toHaveLength(1);
    expect(q.drain()).toHaveLength(0);
  });

  it("counts a gap but still plays the audio", () => {
    const q = new PlaybackQueue();
    q.reset(24000, "t1");
    q.push("t1", 1, bytes(block));
    q.push("t1", 5, bytes(block));
    expect(q.stats.gaps).toBe(1);
    expect(q.drain()).toHaveLength(1);
  });

  it("flushes queued audio on interruption", () => {
    const q = new PlaybackQueue();
    q.reset(24000, "t1");
    q.push("t1", 1, bytes(2048));
    const dropped = q.flush();
    expect(dropped).toBe(2048);
    expect(q.pendingBytes()).toBe(0);
    // a chunk from the old turn after the flush must not be scheduled
    expect(q.push("t1", 2, bytes(2048))).toBe(true);
    expect(q.queued).toBe(1);
  });

  it("discards the previous turn's audio when a new turn starts streaming", () => {
    const q = new PlaybackQueue();
    q.reset(24000, "t1");
    q.push("t1", 1, bytes(4096));
    q.push("t2", 1, bytes(block)); // caller interrupted: new turn owns the audio
    expect(q.currentTurn).toBe("t2");
    expect(q.stats.dropped).toBeGreaterThan(0);
    const out = q.drain();
    expect(out).toHaveLength(1);
    expect(out[0].pcm.byteLength).toBe(block);
  });

  it("emits the odd tail only when the stream is final", () => {
    const q = new PlaybackQueue();
    q.reset(16000, "t1");
    q.push("t1", 1, bytes(1000));
    expect(q.drain(false)).toHaveLength(0);
    const out = q.drain(true);
    expect(out).toHaveLength(1);
    expect(out[0].pcm.byteLength).toBe(1000);
    expect(q.pendingBytes()).toBe(0);
  });

  it("never splits a 16-bit sample", () => {
    const q = new PlaybackQueue(8192);
    q.reset(16000, "t1");
    q.push("t1", 1, bytes(block + 3));
    const out = q.drain(true);
    expect(out[0].pcm.byteLength % 2).toBe(0);
    expect(out[0].pcm.byteLength).toBe(block + 2);
  });

  it("keeps working across many chunks without reordering", () => {
    const q = new PlaybackQueue();
    q.reset(24000, "t1");
    const expected: number[] = [];
    for (let seq = 1; seq <= 40; seq++) {
      q.push("t1", seq, bytes(2048, seq));
      expected.push(seq);
    }
    const out = q.drain(true);
    const merged: number[] = [];
    for (const b of out) for (let i = 0; i < b.pcm.byteLength; i += 2) merged.push(b.pcm[i]);
    // 40 chunks x 1024 samples = 40960 samples, filled with their sequence number
    expect(merged.length).toBe(expected.length * 1024);
    for (let i = 0; i < expected.length; i++) {
      expect(merged[i * 1024]).toBe(expected[i]);
    }
  });
});