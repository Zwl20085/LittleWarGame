import { describe, expect, it } from 'vitest';
import { initialLevel, QualityGovernor } from '../src/render/quality';

/** 2.2: auto quality starts at a tier guessed from the GPU and core count. */
describe('auto quality starting tier', () => {
  it('starts software rasterisers low, integrated GPUs medium, discrete GPUs high', () => {
    expect(initialLevel({ gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))', cores: 8 })).toBe(2);
    expect(initialLevel({ gpu: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)', cores: 8 })).toBe(1);
    expect(initialLevel({ gpu: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0)', cores: 16 })).toBe(0);
    expect(initialLevel({ gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)', cores: 16 })).toBe(0);
    expect(initialLevel({ gpu: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)', cores: 4 })).toBe(1);
    expect(initialLevel({ gpu: '', cores: 0 })).toBe(0);
  });

  it('applies the hint in auto mode only, and steps down from there', () => {
    const q = new QualityGovernor();
    q.setAutoStart(1);
    expect(q.level).toBe(1);
    q.setMode('high');
    expect(q.level).toBe(0);
    q.setMode('auto');
    expect(q.level).toBe(1);
    // 3 s of 40 ms frames after the 12 s cooldown → one tier down.
    for (let t = 0; t < 13; t += 0.016) q.update(0.016);
    let changed = null;
    for (let t = 0; t < 5 && changed === null; t += 0.04) changed = q.update(0.04);
    expect(changed).toBe(2);
  });
});
