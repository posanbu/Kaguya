import type { SituationView } from "@kaguya/schema";

type Frame = SituationView["frames"][number];
export interface SituationStream {
  sceneId: string;
  headFrameId: string;
  updatedAt: string;
  revisions: Frame[];
}
/** A scene keeps its identity. Only its head pointer advances when a new frame arrives. */
export function situationStreams(frames: readonly Frame[]): SituationStream[] {
  const streams = new Map<string, SituationStream>();
  const seen = new Set<string>();
  // Inspection supplies registration order, newest first. Do not sort by event timestamps.
  for (const frame of frames) {
    if (seen.has(frame.id)) continue;
    seen.add(frame.id);
    const id = frame.current.sceneId;
    let stream = streams.get(id);
    if (!stream) {
      stream = {
        sceneId: id,
        headFrameId: frame.id,
        updatedAt: frame.frozenAt,
        revisions: [],
      };
      streams.set(id, stream);
    }
    stream.revisions.push(frame);
  }
  return [...streams.values()];
}

/** Offsets count frozen snapshots back from the scene head, not evidence sequence numbers. */
export function situationTickWindow(
  revisions: readonly Frame[],
  selected: Frame,
  steps: SituationView["steps"],
  radius: number,
) {
  const selectedIndex = revisions.findIndex(
    (frame) => frame.id === selected.id,
  );
  const visible =
    selectedIndex < 0
      ? [selected]
      : revisions.slice(
          Math.max(0, selectedIndex - radius),
          selectedIndex + radius + 1,
        );
  return [...visible].reverse().map((frame) => ({
    frame,
    offset: revisions.findIndex((item) => item.id === frame.id),
    selected: frame.id === selected.id,
    steps: steps
      .filter(
        (step) =>
          step.frameId === frame.id && step.sceneId === frame.current.sceneId,
      )
      .toReversed(),
  }));
}
