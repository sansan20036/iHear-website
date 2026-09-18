import type { ResourceLink } from "./resource-types";

export const RESOURCE_SEEDS: ResourceLink[] = [
  {
    id: "tutor-registration-2026-2027", sortOrder: 10,
    title: { en: "2026–2027 Tutor Registration", zhHant: "2026–2027 小老師報名表", zhHans: "2026–2027 小老师报名表" },
    description: { en: "Apply to join the iHear tutoring team.", zhHant: "申請加入 iHear 小老師團隊。", zhHans: "申请加入 iHear 小老师团队。" },
    url: "https://forms.gle/ouDos4WbYS6X2C3y6",
  },
  {
    id: "tutor-reflection", sortOrder: 20,
    title: { en: "Tutor Reflection", zhHant: "小老師課後反思表", zhHans: "小老师课后反思表" },
    description: { en: "Record observations and reflections after tutoring sessions.", zhHant: "記錄課後觀察與教學反思。", zhHans: "记录课后观察与教学反思。" },
    url: "https://forms.gle/FzayZzgAEiGHsA1b9",
  },
  {
    id: "tutor-availability-2026-2027", sortOrder: 30,
    title: { en: "2026–2027 Teaching Time Availability", zhHant: "2026–2027 可授課時間登記表", zhHans: "2026–2027 可授课时间登记表" },
    description: { en: "Share available teaching times to help schedule sessions.", zhHant: "提供可授課時段，協助安排課程。", zhHans: "提供可授课时段，协助安排课程。" },
    url: "https://forms.gle/r4XamySbXCDWHvAA8",
  },
].map(item => ({ ...item, category: "form", status: "published", version: 1, createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z", createdBy: "migration-020", updatedBy: "migration-020" }));
