"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import type { ClassroomLocale } from "../../../../lib/classroom-locale";
import { roomChannelCopy } from "./room-channel-copy";
import type { RoomChannel } from "./use-room-channel";
import "./room-channel.css";

// The room's public chat (local integration only, 2026-11-24): a message goes to everyone in the
// classroom through our own server. There is no way to choose a receiver: no field, no menu, no
// name to click. The messages are deleted when the lesson ends.
//
// What this does not do, and must not be said to do: it does not switch off Zoom's own chat
// channel, which two people who both run a changed program could still use between themselves.
// This panel shows nothing that arrives on that channel.

const LENGTH = 500;

export default function RoomChat({ channel, locale }: { channel: RoomChannel; locale: ClassroomLocale }) {
  const text = roomChannelCopy[locale];
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLOListElement>(null);
  const atEnd = useRef(true);
  const messages = channel.chat.messages;
  const closed = channel.chat.ended || channel.stopped !== null;

  // New messages are brought into view unless the person has scrolled up to read older ones.
  useEffect(() => {
    const box = list.current;
    if (box && atEnd.current) box.scrollTop = box.scrollHeight;
  }, [messages]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const words = draft.trim();
    if (!words || closed) return;
    channel.chat.say(words);
    setDraft("");
    atEnd.current = true;
  };
  const left = LENGTH - [...draft].length;
  const note = channel.notice && channel.notice.part === "chat" ? (text.refused[channel.notice.code] ?? text.refusedOther(channel.notice.code)) : null;

  return (
    <section className="room-channel-chat" aria-label={text.chat} data-room-chat data-messages={messages.length} data-ended={channel.chat.ended ? "true" : "false"}>
      <p className="room-channel-hint">{text.chatPublic} {text.chatDeleted}</p>
      <ol className="room-channel-messages" ref={list} aria-live="polite"
        onScroll={(event) => { const box = event.currentTarget; atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40; }}>
        {messages.length === 0 && <li className="room-channel-empty">{channel.chat.ended ? text.chatEnded : text.chatEmpty}</li>}
        {messages.map((message) => (
          <li key={message.seq} className="room-channel-message" data-own={message.by === channel.you ? "true" : "false"}>
            <span className="room-channel-name">{message.by === channel.you ? text.chatYou : message.name}</span>
            <span className="room-channel-text">{message.text}</span>
          </li>
        ))}
      </ol>
      {(note || channel.stopped || !channel.online) && <p className="room-channel-hint" role="status">{channel.stopped ? text.stopped : !channel.online ? text.reconnecting : note}</p>}
      <form className="room-channel-send" onSubmit={send}>
        <label className="sr-only" htmlFor="room-channel-chat-input">{text.chatLabel}</label>
        <input id="room-channel-chat-input" type="text" value={draft} maxLength={LENGTH} autoComplete="off" placeholder={text.chatPlaceholder} disabled={closed}
          onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" className="room-channel-tool" disabled={closed || !draft.trim()}>{text.chatSend}</button>
        {left <= 60 && <span className="room-channel-left">{text.chatLeft(Math.max(0, left))}</span>}
      </form>
    </section>
  );
}
