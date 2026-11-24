"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";

import type { ClassroomLocale } from "../../../../lib/classroom-locale";
// @ts-ignore - the room channel's own code, plain JavaScript tested with node --test.
import { BOARD_SPACE, farEnough, fitBoard, lineUnder } from "../../../../lib/room-channel/board-geometry.mjs";
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
//
// A touch on the board is a stroke, so a finger on it does not scroll the page. On a phone the
// board is as wide as the screen and the page under it is longer than the screen (found in the
// real-Zoom sitting of 2026-11-25: the page could hardly be scrolled). So a device with a touch
// screen is offered a third tool, "move the page": while it is chosen a finger on the board scrolls
// and zooms the page as anywhere else, and draws nothing. A board that can no longer be changed
// gives its touches to the page too.

export const BOARD_COLOURS = ["#111827", "#dc2626", "#ea580c", "#16a34a", "#2563eb", "#7c3aed", "#db2777", "#6b7280"];
export const BOARD_WIDTHS = [1, 2, 4, 8];
const SPACE: number = BOARD_SPACE;
// The plain-JavaScript geometry, with the shapes this piece uses of it.
const boardFit = fitBoard as unknown as (width: number, height: number) => { width: number; height: number };
const lineAt = lineUnder as unknown as (lines: BoardLine[], x: number, y: number, options?: { near?: number; skip?: Set<string> | null }) => string | null;
const movedEnough = farEnough as unknown as (last: [number, number], x: number, y: number) => boolean;

type Stroke = { id: string; colour: number; width: number; points: [number, number][] };
// Whether this device has a touch screen: known in the browser only, and it does not change.
const neverChanges = () => () => undefined;
const touchScreen = () => navigator.maxTouchPoints > 0;
const noTouchScreen = () => false;

export default function RoomBoard({ channel, locale }: { channel: RoomChannel; locale: ClassroomLocale }) {
  const text = roomChannelCopy[locale];
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<"pen" | "eraser" | "move">("pen");
  const hasTouch = useSyncExternalStore(neverChanges, touchScreen, noTouchScreen);
  const [colour, setColour] = useState(0);
  const [width, setWidth] = useState(2);
  const [asking, setAsking] = useState(false);
  const [, setTick] = useState(0);
  const stroke = useRef<Stroke | null>(null);
  // The pointer that draws or erases now (a mouse, one finger, a pen), from its press to its release.
  const drawingWith = useRef<number | null>(null);
  const erasing = useRef(new Set<string>());
  const lines = channel.board.lines;
  const linesNow = useRef(lines);
  linesNow.current = lines;
  const ended = channel.board.ended;
  const readOnly = ended || channel.stopped !== null;
  const boardNow = useRef(channel.board);
  boardNow.current = channel.board;
  // The board goes from the page while a line is being drawn (a share takes the stage): the line is closed.
  useEffect(() => () => { const own = stroke.current; if (own) { boardNow.current.end(own.id); stroke.current = null; } }, []);

  // The largest 4:3 box that fits the frame.
  useEffect(() => {
    const box = frame.current;
    if (!box) return undefined;
    const fit = () => {
      const available = box.getBoundingClientRect();
      const fitted = boardFit(available.width, available.height);
      setSize((before) => (before.width === fitted.width && before.height === fitted.height ? before : fitted));
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
    const found = lineAt(linesNow.current, x, y, { skip: erasing.current });
    if (found) { erasing.current.add(found); channel.board.erase(found); }
  };
  // The line under the pen is closed and is the room's from here on.
  const finish = () => {
    drawingWith.current = null;
    const own = stroke.current;
    if (!own) return;
    channel.board.end(own.id);
    stroke.current = null;
    // The finished line is the room's now (shown as "not confirmed yet" until the server has it).
    channel.board.refresh();
  };
  const down = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (readOnly || tool === "move" || (event.pointerType === "mouse" && event.button !== 0)) return;
    // One pointer draws at a time: a second finger, or the side of a hand, coming down while a line
    // is being drawn is left alone (two touches used to pull one line to and fro between them). A
    // pointer the board no longer holds has gone without saying so: its line is closed first.
    if (drawingWith.current !== null) {
      if (event.currentTarget.hasPointerCapture(drawingWith.current)) return;
      finish();
    }
    event.preventDefault();
    const [x, y] = placeOf(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingWith.current = event.pointerId;
    if (tool === "eraser") { eraseAt(x, y); return; }
    const id = channel.board.begin(colour, width);
    if (!id) return;
    stroke.current = { id, colour, width, points: [[x, y]] };
    channel.board.add(id, [[x, y]]);
    redraw();
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    // Only the pointer that was pressed on the board, and only until it is released.
    if (readOnly || event.pointerId !== drawingWith.current) return;
    const own = stroke.current;
    const [x, y] = placeOf(event);
    if (tool === "eraser") { eraseAt(x, y); return; }
    if (!own) return;
    const last = own.points[own.points.length - 1];
    if (!movedEnough(last, x, y)) return;
    own.points.push([x, y]);
    if (!channel.board.add(own.id, [[x, y]])) { stroke.current = null; redraw(); return; }
    // Only the new piece is drawn: the picture is not painted again for every move of the pen.
    const context = canvas.current?.getContext("2d");
    if (context) pen(context, { color: own.colour, width: own.width, points: own.points }, own.points.length - 1);
  };
  // Released, taken over by the browser, or no longer held by the board: all three end the line.
  const up = (event: ReactPointerEvent<HTMLCanvasElement>) => { if (event.pointerId === drawingWith.current) finish(); };
  // Where a finger on the board goes: to the board (a stroke), or to the page (scrolling, zooming).
  const touchGoesTo = readOnly || tool === "move" ? "page" : "board";

  const undo = channel.board.undo;
  const undoLeft = undo ? Math.max(0, (undo.until - Date.now()) / 1000) : 0;
  const note = channel.notice && channel.notice.part === "board" ? (text.refused[channel.notice.code] ?? text.refusedOther(channel.notice.code)) : null;

  return (
    <section className="room-channel-board" aria-label={text.board} data-room-board data-lines={lines.length} data-waiting={channel.waiting} data-ended={ended ? "true" : "false"}>
      <div className="room-channel-tools" role="toolbar" aria-label={text.board}>
        <div className="room-channel-group">
          <button type="button" className="room-channel-tool" aria-pressed={tool === "pen"} disabled={readOnly} onClick={() => setTool("pen")}>{text.pen}</button>
          <button type="button" className="room-channel-tool" aria-pressed={tool === "eraser"} disabled={readOnly} onClick={() => setTool("eraser")}>{text.eraser}</button>
          {hasTouch && <button type="button" className="room-channel-tool" data-board-move aria-pressed={tool === "move"} disabled={readOnly} onClick={() => setTool("move")}>{text.move}</button>}
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
        {channel.stopped ? text.stopped : ended ? text.ended : !channel.online ? text.reconnecting : note ?? (tool === "move" ? text.moveHint : tool === "eraser" ? text.eraserHint : hasTouch ? text.boardHintTouch : text.boardHint)}
        {channel.waiting > 0 && channel.online && !readOnly ? ` ${text.sending(channel.waiting)}` : ""}
      </p>
      <div className="room-channel-frame" ref={frame}>
        <canvas ref={canvas} className="room-channel-canvas" data-tool={tool} data-touch={touchGoesTo} role="img" aria-label={text.board} style={{ width: size.width, height: size.height }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} />
      </div>
    </section>
  );
}
