"use client";

import { useId, useState } from "react";

import type { ClassroomLocale } from "../../../../lib/classroom-locale";
import { roomChannelCopy, roomChannelNoticeText } from "./room-channel-copy";
import type { RoomChannel } from "./use-room-channel";
import "./room-channel.css";

// The share turn as people see it (local integration only, 2026-11-24): who shares now, the
// button that starts or stops one's own share, and handing the share to one named person.
//
//   <RoomTurn channel={channel} locale={locale} />
//
// people: who can be handed the share: { id, name }, id being the person's place on the lesson's
// list (the participant id, which is also the userKey Zoom carries). Left out, it is the server's
// own list (channel.people: everyone let into the lesson and not taken out); a page that knows who
// is really connected may give a shorter one. The person's own entry may be in the list; it is left
// out of "hand the share to".
// button={false}: the page has a share button of its own (which calls channel.share.start() and
// .stop()); this piece then shows only who shares, the offer and the hand-over.
//
// The rules are not here. A share starts only with the turn (lib/room-channel/share-control.mjs);
// the server decides who holds it, takes it back from a holder who fell silent or left, and lets a
// turn handed over wait ten seconds for the person named and for nobody else
// (lib/room-channel/share-turn.mjs).
//
// What this does not do, and must not be said to do: it cannot stop a changed program from
// starting a share on Zoom without the turn. Pages do not show such a stream.

export type RoomTurnPerson = { id: string; name: string };

export default function RoomTurn({ channel, people = channel.people, locale, button = true }: { channel: RoomChannel; people?: readonly RoomTurnPerson[]; locale: ClassroomLocale; button?: boolean }) {
  const text = roomChannelCopy[locale];
  const share = channel.share;
  const field = useId();
  const [chosen, setChosen] = useState("");
  const [working, setWorking] = useState(false);

  const others = people.filter((person) => person.id !== channel.you);
  // Someone chosen who has left the room since is no longer chosen.
  const to = others.some((person) => person.id === chosen) ? chosen : "";
  const nameOf = (id: string) => (people.find((person) => person.id === id) ?? channel.people.find((person) => person.id === id))?.name ?? text.turnSomeone;
  const gone = channel.stopped !== null;
  const offeredElsewhere = share.offeredTo !== null && !share.offeredToMe;

  const state = share.mine ? text.turnYou
    : share.holder !== null ? text.turnHolder(nameOf(share.holder))
      : share.offeredToMe ? text.turnOfferedYou
        : share.offeredTo !== null ? text.turnOfferedTo(nameOf(share.offeredTo))
          : text.turnNobody;
  const note = gone ? text.stopped : !channel.online ? text.reconnecting : roomChannelNoticeText(locale, channel.notice?.part === "turn" ? channel.notice : null);

  // One press at a time: asking for the turn and the browser's own window both take a moment.
  const run = (work: () => Promise<unknown>) => {
    if (working) return;
    setWorking(true);
    channel.dismissNotice();
    void work().catch(() => undefined).finally(() => setWorking(false));
  };

  return (
    <section className="room-channel-turn" aria-label={text.turn} data-room-turn data-holder={share.holder ?? ""} data-mine={String(share.mine)} data-sharing={String(share.sharing)}
      data-offered-to={share.offeredTo ?? ""} data-offered-to-me={String(share.offeredToMe)}>
      <p className="room-channel-turn-state" data-room-turn-state role="status">{state}</p>

      {button && !share.offeredToMe && (
        <button type="button" className="room-channel-tool" data-room-turn-button aria-pressed={share.sharing}
          disabled={gone || working || (!share.sharing && (share.busy || offeredElsewhere))}
          onClick={() => run(() => (share.sharing ? share.stop() : share.start()))}>
          {share.sharing ? text.turnStop : text.turnShare}
        </button>
      )}

      {/* The share was handed to this person: one press takes it and starts the share. */}
      {share.offeredToMe && (
        <button type="button" className="room-channel-tool" data-room-turn-take disabled={gone || working} onClick={() => run(() => share.start())}>{text.turnTake}</button>
      )}

      {/* The holder hands the share to one person; the holder's own share stops first. */}
      {share.mine && !gone && (
        others.length === 0 ? <p className="room-channel-hint">{text.turnNoOne}</p> : (
          <div className="room-channel-give">
            <label htmlFor={field}>{text.turnGiveTo}</label>
            <select id={field} data-room-turn-to value={to} onChange={(event) => setChosen(event.target.value)}>
              <option value="">{text.turnChoose}</option>
              {others.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
            <button type="button" className="room-channel-tool" data-room-turn-give disabled={!to || working} onClick={() => run(async () => { await share.handOver(to); setChosen(""); })}>{text.turnGive}</button>
          </div>
        )
      )}

      {note && <p className="room-channel-hint" data-room-turn-note role="status">{note}</p>}
    </section>
  );
}
