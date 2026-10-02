import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Letterbox } from "./components/Overlays";
import { ClipScene, ColdOpen, EndCard, TitleCard } from "./scenes/Scenes";

/**
 * Little War trailer: cold open → title slam → six gameplay beats → end card.
 * Each beat is its own sequence node so it can be retimed in Studio.
 */
export const Trailer: React.FC = () => {
  const { fps } = useVideoConfig();
  const t = linearTiming({ durationInFrames: 10 });
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <TransitionSeries name="Trailer">
        <TransitionSeries.Sequence name="Cold open" durationInFrames={100} premountFor={fps}>
          <ColdOpen />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />
        <TransitionSeries.Sequence name="Title" durationInFrames={110} premountFor={fps}>
          <TitleCard />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />
        <TransitionSeries.Sequence name="Battle front" durationInFrames={150} premountFor={fps}>
          <ClipScene clip="front" trimSec={3} kicker="THOUSANDS OF SOLDIERS" line="Armies form living battle lines across the map" index="01" zoomIn />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />
        <TransitionSeries.Sequence name="River" durationInFrames={150} premountFor={fps}>
          <ClipScene clip="river" trimSec={1} kicker="EVERY RIVER IS A FRONT" line="Hold the banks. Mass at the crossing. Force the bridge." index="02" zoomIn={false} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />
        <TransitionSeries.Sequence name="City" durationInFrames={150} premountFor={fps}>
          <ClipScene clip="city" trimSec={1} kicker="FIGHT FOR EVERY TOWN" line="Procedural maps: mountains, rivers, villages, cities" index="03" zoomIn />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />
        <TransitionSeries.Sequence name="Artillery" durationInFrames={150} premountFor={fps}>
          <ClipScene clip="artillery" trimSec={1} kicker="BRING UP THE GUNS" line="Real ballistic arcs over ridges and rooftops" index="04" zoomIn={false} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />
        <TransitionSeries.Sequence name="Convoys" durationInFrames={150} premountFor={fps}>
          <ClipScene clip="convoy" trimSec={1} kicker="CUT THEIR SUPPLY" line="Truck convoys feed the front — or it starves" index="05" zoomIn />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />
        <TransitionSeries.Sequence name="Command" durationInFrames={150} premountFor={fps}>
          <ClipScene clip="duel1v1" trimSec={1} kicker="COMMAND. OR JUST WATCH." line="Plan the war — the AI reads the ground and fights it" index="06" zoomIn={false} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />
        <TransitionSeries.Sequence name="End card" durationInFrames={140} premountFor={fps}>
          <EndCard />
        </TransitionSeries.Sequence>
      </TransitionSeries>
      <Letterbox />
      {/* Sound: low war drone bed, a boom on the title slam, whooshes into each beat. */}
      <Audio src={staticFile("sfx/drone.wav")} volume={0.32} />
      <Sequence from={98}><Audio src={staticFile("sfx/boom.wav")} volume={0.9} /></Sequence>
      <Sequence from={107}><Audio src={staticFile("sfx/boom.wav")} volume={0.7} /></Sequence>
      <Sequence from={198}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.5} /></Sequence>
      <Sequence from={338}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.5} /></Sequence>
      <Sequence from={478}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.5} /></Sequence>
      <Sequence from={618}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.5} /></Sequence>
      <Sequence from={758}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.5} /></Sequence>
      <Sequence from={898}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.5} /></Sequence>
      <Sequence from={1038}><Audio src={staticFile("sfx/boom.wav")} volume={0.6} /></Sequence>
    </AbsoluteFill>
  );
};

/** 100+110+150*6+140 = 1250 frames, minus 8 transitions × 10 = 1170 frames (39 s). */
export const TRAILER_FRAMES = 1170;
