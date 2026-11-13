"use client";

import { useEffect, useState } from "react";

import { browserClassroomLocale, htmlLangOf, type ClassroomLocale } from "../../../lib/classroom-locale";
import { lobbyCopy } from "../classroom-lobby-copy";
import { DeviceCheck, LobbyIcon, LobbyNav } from "../classroom-lobby-parts";

// /classroom/device-check: the camera, microphone and sound checked before a lesson, from the lobby.
// Every test starts with its own press and stays on this device.
export default function DeviceCheckPage() {
  const [locale, setLocale] = useState<ClassroomLocale>("zhHant");
  const words = lobbyCopy[locale];
  useEffect(() => {
    setLocale(browserClassroomLocale());
  }, []);
  useEffect(() => {
    document.documentElement.lang = htmlLangOf(locale);
  }, [locale]);
  return (
    <main className="classroom-room lobby lobby-check-page">
      <LobbyNav locale={locale} onLocale={setLocale} text={words}>
        <a className="lobby-nav-link" href="/classroom">{words.toLobby}</a>
      </LobbyNav>
      <div className="lobby-check-intro">
        <span className="lobby-eyebrow">{words.eyebrow}</span>
        <h1>{words.checkPageTitle}</h1>
        <p className="lobby-muted">{words.checkPageIntro}</p>
      </div>
      <DeviceCheck text={words} />
      <a className="lobby-back" href="/classroom"><LobbyIcon name="arrow" />{words.backToLobby}</a>
    </main>
  );
}
