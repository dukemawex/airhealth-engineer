import { describe, expect, it } from "vitest";
import { downmix, encodeWav, resampleLinear, wavDurationMs } from "@/lib/audio/wav";
import { isWav } from "@/lib/meta/media";

describe("wav helpers", () => {
  it("encodes a valid 16 kHz mono PCM16 WAV", () => {
    const wav = encodeWav(new Float32Array(16_000).fill(0.5));
    expect(isWav(wav)).toBe(true);
    const v = new DataView(wav.buffer);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(32_000);
    expect(v.getInt16(44, true)).toBe(16383);
    expect(wavDurationMs(wav)).toBe(1000);
  });

  it("clamps out-of-range samples", () => {
    const wav = encodeWav(Float32Array.from([2, -2]));
    const v = new DataView(wav.buffer);
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
  });

  it("downmixes stereo by averaging and resamples 48 kHz to 16 kHz", () => {
    const mono = downmix([Float32Array.from([1, 0, 1]), Float32Array.from([0, 0, 1])]);
    expect(Array.from(mono)).toEqual([0.5, 0, 1]);
    const out = resampleLinear(new Float32Array(48_000).fill(0.25), 48_000, 16_000);
    expect(out.length).toBe(16_000);
    expect(out[100]).toBeCloseTo(0.25);
    expect(resampleLinear(mono, 16_000, 16_000)).toBe(mono);
  });
});
