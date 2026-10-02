// Single source of truth for the trailer look. Never inline colours/easings in components.
import { Easing } from "remotion";
import { loadFont as loadStencil } from "@remotion/google-fonts/BigShouldersStencil";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";

const stencil = loadStencil("normal", { weights: ["800", "900"], subsets: ["latin"] });
const oswald = loadOswald("normal", { weights: ["400", "600"], subsets: ["latin"] });

export const theme = {
  colors: {
    // Warm WWII operations-room grade (matches the game's title screen).
    bg: "#14110C",
    bgAlt: "#221C14",
    primary: "#C9A04A", // brass — THE hero colour, max one element per frame
    accent: "#E9DFC8", // paper
    text: "#F4ECD9",
    textDim: "#B9AE96",
    glow: "rgba(201, 160, 74, 0.45)",
    sepia: "#7A5A2E",
  },
  fonts: {
    display: stencil.fontFamily,
    body: oswald.fontFamily,
  },
  ease: {
    out: Easing.bezier(0.16, 1, 0.3, 1),
    inOut: Easing.bezier(0.83, 0, 0.17, 1),
    in: Easing.bezier(0.7, 0, 0.84, 0),
  },
  spring: {
    snappy: { damping: 14, stiffness: 160, mass: 0.6 },
    smooth: { damping: 20, stiffness: 90, mass: 1 },
    slam: { damping: 12, stiffness: 220, mass: 0.9 },
  },
} as const;

/** Seconds → frames helper so no magic frame numbers appear in scenes. */
export const sec = (fps: number, s: number): number => Math.round(fps * s);
