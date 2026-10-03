/**
 * Ordered assistant audio queue.
 *
 * The wire is a stream of binary PCM frames that must reach the speaker in order,
 * exactly once, and must be droppable the instant the caller interrupts. Keeping
 * this logic out of the component is what makes it testable: the old inline
 * version silently discarded audio whenever an event arrived out of order.
 */

export interface QueueStats {
  added: number;
  played: number;
  dropped: number;
  duplicates: number;
  gaps: number;
  bytesAdded: number;
  bytesPlayed: number;
}

export type TurnId = string | null | undefined;

export class PlaybackQueue {
  private rate = 0;
  private turnId: TurnId = null;
  private lastSeq = -1;
  private pending: Uint8Array[] = [];
  private readonly blockSize: number;
  readonly stats: QueueStats = {
    added: 0,
    played: 0,
    dropped: 0,
    duplicates: 0,
    gaps: 0,
    bytesAdded: 0,
    bytesPlayed: 0,
  };

  /** @param blockSize bytes per scheduled block (8192 = 4096 samples mono s16) */
  constructor(blockSize = 8192) {
    this.blockSize = blockSize;
  }

  /** Start a new reply stream. Any audio still queued belongs to the old turn. */
  reset(rate: number, turnId: TurnId = null): void {
    this.stats.dropped += this.pendingBytes();
    this.pending = [];
    this.rate = rate;
    this.turnId = turnId ?? null;
    this.lastSeq = -1;
  }

  /**
   * Accept one frame.
   * Returns true when the frame was queued, false when it was rejected as a
   * duplicate, a stale turn, or audio for a stream that never started.
   */
  push(turnId: TurnId, seq: number, data: ArrayBuffer | Uint8Array): boolean {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength === 0) return false;
    const incoming = turnId ?? null;
    if (this.rate === 0) return false; // audio before audio_start: protocol error
    if (incoming !== this.turnId) {
      // A different turn is speaking: everything queued is now stale.
      this.reset(this.rate, incoming);
    }
    if (seq <= this.lastSeq) {
      this.stats.duplicates += 1;
      return false;
    }
    if (this.lastSeq >= 0 && seq > this.lastSeq + 1) {
      this.stats.gaps += 1;
    }
    this.lastSeq = seq;
    this.pending.push(bytes);
    this.stats.added += 1;
    this.stats.bytesAdded += bytes.byteLength;
    return true;
  }

  /**
   * Hand back every complete block that can be scheduled now, in order.
   * The tail stays queued until more audio arrives (or `final` is true).
   */
  drain(final = false): { pcm: Uint8Array; rate: number }[] {
    if (!this.pending.length || !this.rate) return [];
    const total = this.pending.reduce((s, p) => s + p.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of this.pending) {
      merged.set(p, off);
      off += p.byteLength;
    }
    // never split a sample
    const usable = merged.byteLength - (merged.byteLength % 2);
    const processLen = final ? usable : Math.floor(usable / this.blockSize) * this.blockSize;
    if (processLen === 0) {
      if (final && usable > 0) {
        this.pending = [];
        this.stats.played += 1;
        this.stats.bytesPlayed += usable;
        return [{ pcm: merged.subarray(0, usable), rate: this.rate }];
      }
      return [];
    }
    const block = merged.subarray(0, processLen);
    const leftover = merged.subarray(processLen);
    this.pending = leftover.byteLength ? [new Uint8Array(leftover)] : [];
    this.stats.played += 1;
    this.stats.bytesPlayed += processLen;
    return [{ pcm: new Uint8Array(block), rate: this.rate }];
  }

  /** Interruption: throw away everything not yet played. */
  flush(): number {
    const dropped = this.pendingBytes();
    this.stats.dropped += 1;
    this.pending = [];
    this.lastSeq = -1;
    return dropped;
  }

  pendingBytes(): number {
    return this.pending.reduce((s, p) => s + p.byteLength, 0);
  }

  get queued(): number {
    return this.pending.length;
  }

  get currentTurn(): TurnId {
    return this.turnId;
  }

  get sampleRate(): number {
    return this.rate;
  }

  get lastSequence(): number {
    return this.lastSeq;
  }
}