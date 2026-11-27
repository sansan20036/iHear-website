"use client";

import { useEffect, useState } from "react";

// Round 18f (the sixth real-Zoom sitting, 2026-11-27): an Android phone showed the computer's tile
// empty while the computer saw the phone. The only change on the page since the fourth sitting, when
// the phone saw the computer, was "fill" (object-fit: cover on each tile's <video>). This check, on the
// online test site only (lib/classroom-test-tools.ts), reads on the page itself what each tile holds:
// Zoom's player, its <video> (picture size, ready state, playing, frames, fit, box) or <canvas>, and
// whether Zoom drew on the videos container's own canvas. Its button turns "fill" off and on for this
// page, so one look tells whether fill hides the picture. It reads the page only and sends nothing.

type Line = { who: string; video: string; detail: string };

function videoOf(element: HTMLVideoElement) {
  const box = element.getBoundingClientRect();
  const quality = typeof element.getVideoPlaybackQuality === "function" ? element.getVideoPlaybackQuality() : null;
  return [
    `video ${element.videoWidth}x${element.videoHeight}`,
    `ready ${element.readyState}`,
    element.paused ? "paused" : "playing",
    `t ${element.currentTime.toFixed(1)}`,
    `frames ${quality ? quality.totalVideoFrames : "?"}`,
    `fit ${getComputedStyle(element).objectFit}`,
    `box ${Math.round(box.width)}x${Math.round(box.height)}`,
  ].join(" ");
}

// Round 18i (the eighth real-Zoom sitting: the computer's video on an Android phone was letterboxed):
// every player in the tile, whether the page made it (data-ihear-fill), its fill-mode, and what Zoom
// says of it (its render kind and the fill it read), read from Zoom's own element, if it says.
function playerOf(player: Element, index: number) {
  const zoom = player as Element & { render?: { renderType?: unknown }; debugRenderLabel?: (type: unknown) => unknown; getRenderParams?: () => { fillMode?: unknown } };
  let kind: unknown = "?";
  let read: unknown = "?";
  try {
    const type = zoom.render?.renderType;
    kind = typeof zoom.debugRenderLabel === "function" && type !== undefined ? zoom.debugRenderLabel(type) : type ?? "none";
    read = typeof zoom.getRenderParams === "function" ? zoom.getRenderParams()?.fillMode : "?";
  } catch {
    kind = "unreadable";
  }
  const box = player.getBoundingClientRect();
  const parts = [...player.querySelectorAll("video, canvas")].map((element) =>
    element instanceof HTMLVideoElement ? videoOf(element) : `canvas ${(element as HTMLCanvasElement).width}x${(element as HTMLCanvasElement).height}`);
  const inside = parts.length ? parts.join(" | ") : `holds ${[...player.querySelectorAll("*")].map((element) => element.tagName.toLowerCase()).join(">") || "nothing"}`;
  return `p${index + 1}${player.hasAttribute("data-ihear-fill") ? " ours" : " zoom's"} node ${player.getAttribute("node-id") ?? "-"} fill-mode ${player.getAttribute("fill-mode") ?? "-"} (Zoom read ${String(read)}) kind ${String(kind)} ${Math.round(box.width)}x${Math.round(box.height)} · ${inside}`;
}

function lineOf(tile: HTMLElement): Line {
  const who = tile.querySelector(".room2-tile-name")?.textContent?.trim() || tile.dataset.person || "?";
  const players = [...tile.querySelectorAll("video-player")];
  if (!players.length) return { who, video: tile.dataset.video ?? "?", detail: "no player" };
  return { who, video: tile.dataset.video ?? "?", detail: `${players.length} player(s): ${players.map(playerOf).join(" || ")}` };
}

function containerLine() {
  const container = document.querySelector<HTMLElement>(".classroom-zoom-videos");
  if (!container) return "videos container: none (not Zoom)";
  const canvas = container.shadowRoot?.querySelector("canvas");
  const style = getComputedStyle(container);
  return `videos container: display ${style.display}, background ${style.backgroundColor}, Zoom canvas ${canvas ? `${canvas.width}x${canvas.height}` : "none"}`;
}

export function VideoCheck({ fill, onFill, onClose, text }: {
  fill: boolean; onFill: () => void; onClose: () => void;
  text: { videoCheck: string; videoCheckClose: string; videoFillOn: string; videoFillOff: string };
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [head, setHead] = useState("");
  useEffect(() => {
    const read = () => {
      setHead(containerLine());
      setLines([...document.querySelectorAll<HTMLElement>(".classroom-media-tile")].map(lineOf));
    };
    read();
    const timer = window.setInterval(read, 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section className="room2-video-check" data-video-check aria-label={text.videoCheck}>
      <div className="room2-video-check-bar">
        <strong>{text.videoCheck}</strong>
        <button type="button" data-video-fill={fill ? "on" : "off"} onClick={onFill}>{fill ? text.videoFillOn : text.videoFillOff}</button>
        <button type="button" onClick={onClose}>{text.videoCheckClose}</button>
      </div>
      <p>{head}</p>
      <ol>
        {lines.map((line, index) => <li key={index}><b>{line.who}</b> [{line.video}] {line.detail}</li>)}
      </ol>
    </section>
  );
}
