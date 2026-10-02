import React from "react";
import { AbsoluteFill, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { BgMesh, Finish } from "../components/Overlays";
import { Caption, WordReveal } from "../components/Type";
import { theme } from "../theme";

/** Gameplay footage with a slow push-in (Ken Burns on video) — the asset layer. */
const Footage: React.FC<{ clip: string; trimSec: number; zoomIn: boolean; dim?: number }> = ({ clip, trimSec, zoomIn, dim = 0 }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = interpolate(frame, [0, durationInFrames], zoomIn ? [1.0, 1.08] : [1.08, 1.0], { easing: theme.ease.inOut, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pan = interpolate(frame, [0, durationInFrames], [0, zoomIn ? -24 : 24], { easing: theme.ease.inOut, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <OffthreadVideo src={staticFile(`clips/${clip}.webm`)} trimBefore={Math.round(trimSec * fps)} muted
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${s}) translateX(${pan}px)`, filter: "saturate(0.88) contrast(1.08)" }} />
      {dim > 0 && <AbsoluteFill style={{ background: `rgba(10,8,5,${dim})` }} />}
    </AbsoluteFill>
  );
};

export interface ClipSceneProps {
  clip: string;
  trimSec: number;
  kicker: string;
  line: string;
  index: string;
  zoomIn: boolean;
}

/** One trailer beat: footage → caption → grade/grain/vignette. */
export const ClipScene: React.FC<ClipSceneProps> = ({ clip, trimSec, kicker, line, index, zoomIn }) => (
  <AbsoluteFill>
    <BgMesh />
    <Footage clip={clip} trimSec={trimSec} zoomIn={zoomIn} />
    <Caption kicker={kicker} line={line} index={index} />
    <Finish />
  </AbsoluteFill>
);

/** Cold open: overview footage, darkened, with a staggered line of copy. */
export const ColdOpen: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <BgMesh />
      <Footage clip="overview" trimSec={0.5} zoomIn dim={0.45} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <WordReveal text="EUROPE, 1944." delay={Math.round(fps * 0.3)} per={5}
          style={{ justifyContent: "center", fontFamily: theme.fonts.body, fontSize: 46, letterSpacing: "0.45em", color: theme.colors.textDim }} />
        <WordReveal text="FOUR CITIES. ONE FRONT." delay={Math.round(fps * 1.0)} per={5} highlight="FRONT"
          style={{ justifyContent: "center", marginTop: 26, fontFamily: theme.fonts.display, fontWeight: 900, fontSize: 132, color: theme.colors.text, gap: 34 }} />
      </AbsoluteFill>
      <Finish />
    </AbsoluteFill>
  );
};

/** Title slam: huge stencil wordmark over the battle. */
export const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const slam = spring({ frame: frame - 2, fps, config: theme.spring.slam });
  const war = spring({ frame: frame - 9, fps, config: theme.spring.slam });
  const sub = spring({ frame: frame - 20, fps, config: theme.spring.smooth });
  const breathe = 1 + Math.sin(frame / 22) * 0.008;
  const exit = interpolate(frame, [durationInFrames - 10, durationInFrames - 2], [1, 0], { easing: theme.ease.in, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <BgMesh />
      <Footage clip="front" trimSec={2} zoomIn={false} dim={0.55} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: exit }}>
        <div style={{ display: "flex", gap: 46, transform: `scale(${breathe})` }}>
          <span style={{ fontFamily: theme.fonts.display, fontWeight: 900, fontSize: 250, lineHeight: 1, color: theme.colors.accent, opacity: slam, transform: `translateY(${interpolate(slam, [0, 1], [-60, 0])}px) scale(${interpolate(slam, [0, 1], [1.25, 1])})` }}>LITTLE</span>
          <span style={{ fontFamily: theme.fonts.display, fontWeight: 900, fontSize: 250, lineHeight: 1, color: theme.colors.primary, textShadow: `0 0 60px ${theme.colors.glow}`, opacity: war, transform: `translateY(${interpolate(war, [0, 1], [60, 0])}px) scale(${interpolate(war, [0, 1], [1.25, 1])})` }}>WAR</span>
        </div>
        <div style={{ marginTop: 18, fontFamily: theme.fonts.body, fontSize: 40, letterSpacing: "0.5em", color: theme.colors.text, opacity: sub, transform: `translateY(${interpolate(sub, [0, 1], [24, 0])}px)` }}>
          A WWII BATTLE DIORAMA
        </div>
      </AbsoluteFill>
      <Finish />
    </AbsoluteFill>
  );
};

/** End card: wordmark + call to action. */
export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - 4, fps, config: theme.spring.smooth });
  const cta = spring({ frame: frame - 18, fps, config: theme.spring.snappy });
  const glow = 0.5 + 0.5 * Math.sin(frame / 14);
  return (
    <AbsoluteFill>
      <BgMesh />
      <Footage clip="overview" trimSec={4} zoomIn={false} dim={0.7} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 30, opacity: p, transform: `translateY(${interpolate(p, [0, 1], [40, 0])}px) scale(${interpolate(p, [0, 1], [0.94, 1])})` }}>
          <span style={{ fontFamily: theme.fonts.display, fontWeight: 900, fontSize: 170, color: theme.colors.accent }}>LITTLE</span>
          <span style={{ fontFamily: theme.fonts.display, fontWeight: 900, fontSize: 170, color: theme.colors.accent }}>WAR</span>
        </div>
        <WordReveal text="Procedural fronts · Thousands of soldiers · Your strategy" delay={12} per={3}
          style={{ justifyContent: "center", marginTop: 10, fontFamily: theme.fonts.body, fontSize: 40, color: theme.colors.textDim, gap: 14 }} />
        <div style={{ marginTop: 46, padding: "16px 38px", border: `3px solid ${theme.colors.primary}`, fontFamily: theme.fonts.body, fontWeight: 600, fontSize: 44, letterSpacing: "0.25em", color: theme.colors.primary, boxShadow: `0 0 ${30 + glow * 30}px ${theme.colors.glow}`, opacity: cta, transform: `scale(${interpolate(cta, [0, 1], [0.9, 1])})` }}>
          PLAY IN YOUR BROWSER
        </div>
      </AbsoluteFill>
      <Finish />
    </AbsoluteFill>
  );
};
