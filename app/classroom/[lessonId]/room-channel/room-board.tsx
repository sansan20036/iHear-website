"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { ClassroomLocale } from "../../../../lib/classroom-locale";
import { roomChannelCopy } from "./room-channel-copy";
import type { BoardLine, RoomChannel } from "./use-room-channel";
import "./room-channel.css";

// The room's own whiteboard (local integration only, 2026-11-24): everyone in the classroom draws
// on the same board, through our own server (lib/room-channel). It is not Zoom's whiteboard and
// needs no host. What a person draws shows under their pen at once; the others see it when the
// server has taken it.
//
// The board is one picture of fixed shape (4:3) whatever the screen, so that a line sits in the
// same place for everyone. It works with a mouse, a finger or a pen.

export const BOARD_COLOURS = ["#111827", "#dc2626", "#ea580c", "#16a34a", "#2563eb", "#7c3aed", "#db2777", "#6b7280"];
export const BOARD_WIDTHS = [1, 2, 4, 8];
const SPACE = 10_000;          // the board's own space on both axes (lib/room-channel/board.mjs)
const STEP = 18;               // a new point only this far (in the board's space) from the last one
const NEAR = 140;              // how near a tap must be to a line to erase it

type Stroke = { id: string; colour: number; width: number; points: [number, number][] };

// How far a place is from a line (in the board's space; a line of one point is a dot).
function distanceTo(line: BoardLine, x: number, y: number) {
  let best = Infinity;
  const points = line.points;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index], [bx, by] = points[Math.min(index + 1, points.length - 1)];
    const dx = bx - ax, dy = by - ay;
    const along = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - (ax + along * dx), y - (ay + along * dy)));
  }
  return best;
}

export default function RoomBoard({ channel, locale }: { channel: RoomChannel; locale: ClassroomLocale }) {
  const text = roomChannelCopy[locale];
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [colour, setColour] = useState(0);
  const [width, setWidth] = useState(2);
  const [asking, setAsking] = useState(false);
  const [, setTick] = useState(0);
  const stroke = useRef<Stroke | null>(null);
  const erasing = useRef(new Set<string>());
  const lines = channel.board.lines;
  const linesNow = useRef(lines);
  linesNow.current = lines;
  const ended = channel.board.ended;
  const readOnly = ended || channel.stopped !== null;

  // The largest 4:3 box that fits the frame.
  useEffect(() => {
    const box = frame.current;
    if (!box) return undefined;
    const fit = () => {
      const available = box.getBoundingClientRect();
      const boardWidth = Math.max(0, Math.floor(Math.min(available.width, (available.height * 4) / 3)));
      setSize((before) => (before.width === boardWidth ? before : { width: boardWidth, height: Math.floor((boardWidth * 3) / 4) }));
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(box);
    return () => watch.disconnect();
  }, []);

  const pen = useCallback((context: CanvasRenderingContext2D, line: { color: number; width: number; points: [number, number][] }, from = 0) => {
    const scaleX = size.width / SPACE, scaleY = size.height / SPACE;
    context.strokeStyle = BOARD_COLOURS[line.color] ?? BOARD_COLOURS[0];
    context.fillStyle = context.strokeStyle;
    context.lineWidth = Math.max(1, (line.width * 2 * size.width) / 1000);
    context.lineCap = "round";
    context.lineJoin = "round";
    const points = line.points;
    if (points.length === 1 && from === 0) {
      context.beginPath();
      context.arc(points[0][0] * scaleX, points[0][1] * scaleY, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }
    context.beginPath();
    const start = Math.max(0, from - 1);
    context.moveTo(points[start][0] * scaleX, points[start][1] * scaleY);
    for (let index = start + 1; index < points.length; index += 1) context.lineTo(points[index][0] * scaleX, points[index][1] * scaleY);
    context.stroke();
  }, [size.height, size.width]);

  // The whole picture: every line the room holds, then the line under this person's pen.
  const redraw = useCallback(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || size.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    if (element.width !== Math.round(size.width * ratio)) { element.width = Math.round(size.width * ratio); element.height = Math.round(size.height * ratio); }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    for (const line of linesNow.current) if (line.points.length) pen(context, line);
    const own = stroke.current;
    if (own && own.points.length) pen(context, { color: own.colour, width: own.width, points: own.points });
  }, [pen, size.height, size.width]);
  useEffect(() => { redraw(); }, [redraw, lines]);
  // A line asked to be erased is no longer asked again once it is gone.
  useEffect(() => { for (const key of erasing.current) if (!lines.some((line) => line.line === key)) erasing.current.delete(key); }, [lines]);
  // The time left to bring a clear back is said in minutes: look again now and then.
  useEffect(() => {
    if (!channel.board.undo) return undefined;
    const timer = window.setInterval(() => setTick((count) => count + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [channel.board.undo]);

  const placeOf = (event: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    return channel.board.point(event.clientX - box.left, event.clientY - box.top, box.width, box.height);
  };
  const eraseAt = (x: number, y: number) => {
    // The line drawn last lies on top: it is the one a tap means.
    for (let index = linesNow.current.length - 1; index >= 0; index -= 1) {
      const line = linesNow.current[index];
      if (line.unconfirmed || erasing.current.has(line.line)) continue;
      if (distanceTo(line, x, y) <= NEAR + line.width * 10) { erasing.current.add(line.line); channel.board.erase(line.line); return; }
    }
  };
  const down = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (readOnly || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    const [x, y] = placeOf(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "eraser") { eraseAt(x, y); return; }
    const id = channel.board.begin(colour, width);
    if (!id) return;
    stroke.current = { id, colour, width, points: [[x, y]] };
    channel.board.add(id, [[x, y]]);
    redraw();
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (readOnly) return;
    const own = stroke.current;
    if (tool === "eraser") { if (event.buttons !== 0 || event.pointerType !== "mouse") { const [x, y] = placeOf(event); if (event.pressure > 0 || event.buttons !== 0) eraseAt(x, y); } return; }
    if (!own) return;
    const [x, y] = placeOf(event);
    const last = own.points[own.points.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) < STEP) return;
    own.points.push([x, y]);
    if (!channel.board.add(own.id, [[x, y]])) { stroke.current = null; redraw(); return; }
    // Only the new piece is drawn: the picture is not painted again for every move of the pen.
    const context = canvas.current?.getContext("2d");
    if (context) pen(context, { color: own.colour, width: own.width, points: own.points }, own.points.length - 1);
  };
  const up = () => {
    const own = stroke.current;
    if (!own) return;
    channel.board.end(own.id);
    stroke.current = null;
    // The finished line is the room's now (shown as "not confirmed yet" until the server has it).
    channel.board.refresh();
  };

  const undo = channel.board.undo;
  const undoLeft = undo ? Math.max(0, (undo.until - Date.now()) / 1000) : 0;
  const note = channel.notice && channel.notice.part === "board" ? (text.refused[channel.notice.code] ?? text.refusedOther(channel.notice.code)) : null;

  return (
    <section className="room-channel-board" aria-label={text.board} data-room-board data-lines={lines.length} data-waiting={channel.waiting} data-ended={ended ? "true" : "false"}>
      <div className="room-channel-tools" role="toolbar" aria-label={text.board}>
        <div className="room-channel-group">
          <button type="button" className="room-channel-tool" aria-pressed={tool === "pen"} disabled={readOnly} onClick={() => setTool("pen")}>{text.pen}</button>
          <button type="button" className="room-channel-tool" aria-pressed={tool === "eraser"} disabled={readOnly} onClick={() => setTool("eraser")}>{text.eraser}</button>
        </div>
        <div className="room-channel-group" role="group" aria-label={text.colour}>
          {BOARD_COLOURS.map((value, index) => (
            <button key={value} type="button" className="room-channel-colour" style={{ background: value }} aria-label={text.colours[index]} title={text.colours[index]} aria-pressed={tool === "pen" && colour === index} disabled={readOnly}
              onClick={() => { setColour(index); setTool("pen"); }} />
          ))}
        </div>
        <div className="room-channel-group" role="group" aria-label={text.width}>
          {BOARD_WIDTHS.map((value, index) => (
            <button key={value} type="button" className="room-channel-width" aria-label={text.widths[index]} title={text.widths[index]} aria-pressed={width === value} disabled={readOnly} onClick={() => setWidth(value)}>
              <span style={{ height: Math.max(2, value * 2) }} />
            </button>
          ))}
        </div>
        <div className="room-channel-group">
          {asking ? (
            <span className="room-channel-ask" role="alertdialog" aria-label={text.clearAsk}>
              <span>{text.clearAsk}</span>
              <button type="button" className="room-channel-tool room-channel-danger" data-board-clear-yes onClick={() => { setAsking(false); channel.board.clear(); }}>{text.clearYes}</button>
              <button type="button" className="room-channel-tool" onClick={() => setAsking(false)}>{text.clearNo}</button>
            </span>
          ) : (
            <button type="button" className="room-channel-tool" data-board-clear disabled={readOnly || lines.length === 0} onClick={() => setAsking(true)}>{text.clear}</button>
          )}
          {undo && undoLeft > 0 && !readOnly && (
            <button type="button" className="room-channel-tool" data-board-undo title={text.undoClearUntil(undoLeft)} onClick={() => channel.board.undoClear()}>{text.undoClear}</button>
          )}
        </div>
      </div>
      <p className="room-channel-hint" aria-live="polite">
        {channel.stopped ? text.stopped : ended ? text.ended : !channel.online ? text.reconnecting : note ?? (tool === "eraser" ? text.eraserHint : text.boardHint)}
        {channel.waiting > 0 && channel.online && !readOnly ? ` ${text.sending(channel.waiting)}` : ""}
      </p>
      <div className="room-channel-frame" ref={frame}>
        <canvas ref={canvas} className="room-channel-canvas" data-tool={tool} role="img" aria-label={text.board} style={{ width: size.width, height: size.height }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      </div>
    </section>
  );
}
