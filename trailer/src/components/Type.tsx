import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

/** Word-by-word reveal (spring rise + fade), staggered 3 frames. */
export const WordReveal: React.FC<{ text: string; delay?: number; per?: number; style?: React.CSSProperties; highlight?: string }> = ({ text, delay = 0, per = 3, style, highlight }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 22, ...style }}>
      {text.split(" ").map((word, i) => {
        const p = spring({ frame: frame - delay - i * per, fps, config: theme.spring.snappy });
        const hot = highlight && word.replace(/[^A-Z]/gi, "").toUpperCase() === highlight.toUpperCase();
        return (
          <span key={i} style={{ display: "inline-block", opacity: p, transform: `translateY(${interpolate(p, [0, 1], [34, 0])}px) scale(${interpolate(p, [0, 1], [0.96, 1])})`, color: hot ? theme.colors.primary : undefined, textShadow: hot ? `0 0 40px ${theme.colors.glow}` : undefined }}>
            {word}
          </span>
        );
      })}
    </div>
  );
};

/** Lower-third caption: stencil kicker + supporting line, with brass rule; animated in and out. */
export const Caption: React.FC<{ kicker: string; line: string; index: string }> = ({ kicker, line, index }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const rule = spring({ frame: frame - 4, fps, config: theme.spring.smooth });
  const exitO = interpolate(frame, [durationInFrames - 12, durationInFrames - 3], [1, 0], { easing: theme.ease.in, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const exitY = interpolate(frame, [durationInFrames - 12, durationInFrames - 3], [0, 24], { easing: theme.ease.in, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const float = Math.sin(frame / 30) * 2;
  return (
    <div style={{ position: "absolute", left: 120, bottom: 150, opacity: exitO, transform: `translateY(${exitY + float}px)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 14 }}>
        <div style={{ fontFamily: theme.fonts.body, fontSize: 30, letterSpacing: "0.3em", color: theme.colors.textDim }}>{index}</div>
        <div style={{ height: 3, width: interpolate(rule, [0, 1], [0, 220]), background: theme.colors.primary }} />
      </div>
      <WordReveal text={kicker} delay={6} style={{ fontFamily: theme.fonts.display, fontWeight: 900, fontSize: 118, lineHeight: 1.0, color: theme.colors.text, letterSpacing: "0.01em", textShadow: "0 6px 30px rgba(0,0,0,0.6)" }} />
      <WordReveal text={line} delay={16} per={2} style={{ marginTop: 14, fontFamily: theme.fonts.body, fontSize: 44, color: theme.colors.accent, gap: 12, textShadow: "0 3px 16px rgba(0,0,0,0.8)" }} />
    </div>
  );
};
