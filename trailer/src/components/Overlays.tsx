import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

/** Slow-moving warm mesh behind everything (never a flat background). */
export const BgMesh: React.FC = () => {
  const frame = useCurrentFrame();
  const d1 = Math.sin(frame / 55) * 50;
  const d2 = Math.cos(frame / 70) * 40;
  return (
    <AbsoluteFill style={{ background: theme.colors.bg }}>
      <div style={{ position: "absolute", width: 1400, height: 1400, borderRadius: "50%", top: -500, left: -300 + d1, filter: "blur(60px)", background: `radial-gradient(circle, ${theme.colors.sepia}55, transparent 62%)` }} />
      <div style={{ position: "absolute", width: 1000, height: 1000, borderRadius: "50%", bottom: -450, right: -250 - d2, filter: "blur(70px)", background: `radial-gradient(circle, ${theme.colors.primary}22, transparent 65%)` }} />
    </AbsoluteFill>
  );
};

/** Colour grade: warm soft-light wash + top/bottom darkening + subtle letterbox. */
export const Grade: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <AbsoluteFill style={{ backgroundColor: theme.colors.sepia, mixBlendMode: "soft-light", opacity: 0.32 }} />
    <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.38), transparent 22%, transparent 70%, rgba(0,0,0,0.55))" }} />
  </AbsoluteFill>
);

/** Procedural film grain with per-frame flicker. */
export const Grain: React.FC = () => {
  const frame = useCurrentFrame();
  const noise = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E")`;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", backgroundImage: noise, backgroundSize: "220px", backgroundPosition: `${(frame * 7) % 220}px ${(frame * 13) % 220}px`, opacity: 0.09, mixBlendMode: "overlay" }} />
  );
};

export const Vignette: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none", background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.55) 100%)" }} />
);

/** Cinematic letterbox bars that ease in at the start of the film. */
export const Letterbox: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const h = interpolate(frame, [0, fps * 0.8], [0, 64], { easing: theme.ease.out, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: h, background: "#000" }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: h, background: "#000" }} />
    </AbsoluteFill>
  );
};

/** Top layers of the five-layer stack, shared by every scene. */
export const Finish: React.FC = () => (
  <>
    <Grade />
    <Grain />
    <Vignette />
  </>
);
