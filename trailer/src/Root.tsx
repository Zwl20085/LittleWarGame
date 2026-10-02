import React from "react";
import { Composition, Folder } from "remotion";
import { ClipScene, ColdOpen, EndCard, TitleCard } from "./scenes/Scenes";
import { Trailer, TRAILER_FRAMES } from "./Trailer";

const W = 1920;
const H = 1080;
const FPS = 30;

export const RemotionRoot: React.FC = () => (
  <>
    <Folder name="Scenes">
      <Composition id="ColdOpen" component={ColdOpen} width={W} height={H} fps={FPS} durationInFrames={100} />
      <Composition id="TitleCard" component={TitleCard} width={W} height={H} fps={FPS} durationInFrames={110} />
      <Composition id="BattleFront" component={ClipScene} width={W} height={H} fps={FPS} durationInFrames={150}
        defaultProps={{ clip: "front", trimSec: 3, kicker: "THOUSANDS OF SOLDIERS", line: "Armies form living battle lines across the map", index: "01", zoomIn: true }} />
      <Composition id="EndCard" component={EndCard} width={W} height={H} fps={FPS} durationInFrames={140} />
    </Folder>
    <Composition id="Trailer" component={Trailer} width={W} height={H} fps={FPS} durationInFrames={TRAILER_FRAMES} />
  </>
);
