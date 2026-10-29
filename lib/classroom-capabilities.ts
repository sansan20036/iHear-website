// What each video service can do on each kind of device, for the room's "this device" notes and
// for the trial checklist. From the vendors' documentation only (2026-10-29/30); nothing here
// has been tried with a real account. "unknown" means the documentation does not say, and the
// trial has to find out. Synthetic is the local stand-in and carries no real media at all.

export type ClassroomDevice = "desktop" | "tablet" | "phone";
export type CapabilityLevel = "native" | "limited" | "none" | "unknown" | "simulated";
export type Capability = { level: CapabilityLevel; note: string };
export type CapabilityName = "video" | "documents" | "whiteboard" | "screenShare" | "fileTransfer" | "recording";
export type ProviderCapabilities = Record<CapabilityName, Record<ClassroomDevice, Capability>>;

const all = (level: CapabilityLevel, note: string) => ({ desktop: { level, note }, tablet: { level, note }, phone: { level, note } });

export const CLASSROOM_CAPABILITIES: Record<"synthetic" | "zoom-video-sdk" | "tencent-lcic", ProviderCapabilities> = {
  synthetic: {
    video: all("simulated", "Local stand-in: no camera, microphone or network"),
    documents: all("simulated", "Not part of the stand-in"),
    whiteboard: all("simulated", "Not part of the stand-in"),
    screenShare: all("simulated", "Not part of the stand-in"),
    fileTransfer: all("simulated", "Not part of the stand-in"),
    recording: all("simulated", "Recording states are simulated by the server's synthetic provider"),
  },
  "zoom-video-sdk": {
    video: {
      desktop: { level: "native", note: "Chrome, Edge, Firefox, Safari (current and two previous versions); 1080p on Chromium only" },
      tablet: { level: "native", note: "iPadOS: 720p, support follows the iPadOS version (all browsers use WebKit)" },
      phone: { level: "native", note: "iOS 16.4+ / Android Chrome 112+ for 720p send; Android Firefox unsupported" },
    },
    documents: {
      desktop: { level: "limited", note: "No PDF/PPT import: share the screen or a tab, or iHear builds its own PDF viewer" },
      tablet: { level: "limited", note: "Can see a shared screen; cannot share one" },
      phone: { level: "limited", note: "Can see a shared screen; cannot share one" },
    },
    whiteboard: {
      desktop: { level: "native", note: "SDK 2.3.5+; only the host or a manager can start it; not saved unless exported to PDF" },
      tablet: { level: "limited", note: "Mobile platforms are not interactive: they see the whiteboard as a shared picture" },
      phone: { level: "limited", note: "Not interactive: seen as a shared picture" },
    },
    screenShare: {
      desktop: { level: "native", note: "Send and receive; tab audio on Chromium" },
      tablet: { level: "limited", note: "Receive only" },
      phone: { level: "limited", note: "Receive only" },
    },
    fileTransfer: all("native", "In-session chat can send files on all platforms (size and type limits: unknown)"),
    recording: all("native", "Cloud recording started and stopped by the iHear server (REST); needs a recording plan"),
  },
  "tencent-lcic": {
    video: {
      desktop: { level: "native", note: "Tencent's classroom page in an iframe; latest desktop Chrome recommended" },
      tablet: { level: "unknown", note: "Web/H5 says only that the browser must support audio and video" },
      phone: { level: "unknown", note: "Web/H5 says only that the browser must support audio and video" },
    },
    documents: {
      desktop: { level: "native", note: "Courseware: PPT, PPTX, Word and PDF transcoded (CreateDocument); class SubType videodoc" },
      tablet: { level: "unknown", note: "Courseware on mobile browsers is not documented" },
      phone: { level: "unknown", note: "Courseware on mobile browsers is not documented" },
    },
    whiteboard: {
      desktop: { level: "native", note: "Built in; how a teacher grants a student drawing rights is not documented" },
      tablet: { level: "unknown", note: "Whiteboard on mobile browsers is not documented" },
      phone: { level: "unknown", note: "Whiteboard on mobile browsers is not documented" },
    },
    screenShare: {
      desktop: { level: "native", note: "Listed as a classroom tool" },
      tablet: { level: "none", note: "TRTC Web cannot share the screen from mobile browsers" },
      phone: { level: "none", note: "TRTC Web cannot share the screen from mobile browsers" },
    },
    fileTransfer: all("unknown", "Not documented beyond courseware"),
    recording: all("limited", "Decided when the room is created (DisableRecord); stopping mid-class from the server is not documented"),
  },
};

/** The device kind from the browser, for showing this device's limits; never for access decisions. */
export function classroomDeviceOf(userAgent: string, maxTouchPoints = 0): ClassroomDevice {
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return "tablet";
  if (/Android/.test(userAgent) && !/Mobile/.test(userAgent)) return "tablet";
  if (/iPhone|iPod|Android.+Mobile|Mobile Safari/.test(userAgent)) return "phone";
  return "desktop";
}

/** The capabilities that are not fully available on this device, for the room's notice. */
export function deviceLimits(provider: string, device: ClassroomDevice) {
  const table = CLASSROOM_CAPABILITIES[provider as keyof typeof CLASSROOM_CAPABILITIES];
  if (!table) return [];
  return (Object.keys(table) as CapabilityName[])
    .map(name => ({ name, ...table[name][device] }))
    .filter(entry => entry.level !== "native");
}
