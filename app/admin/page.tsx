"use client";

import { useEffect, useState } from "react";
import { useAdmin } from "./admin-context";
import { adminFetch, displayError } from "./admin-api";

const copy = {
  en: { title:"Overview", intro:"A quick view of Team and Impact content.", drafts:"Drafts", published:"Published", trash:"Trash", total:"Active records", recent:"Recent activity", noActivity:"No activity has been recorded yet.", loading:"Loading dashboard…" },
  zhHant: { title:"總覽", intro:"快速掌握團隊與成果資料狀態。", drafts:"草稿", published:"已發布", trash:"回收區", total:"使用中資料", recent:"近期操作", noActivity:"尚未有操作記錄。", loading:"正在載入總覽…" },
  zhHans: { title:"总览", intro:"快速掌握团队与成果数据状态。", drafts:"草稿", published:"已发布", trash:"回收区", total:"使用中数据", recent:"近期操作", noActivity:"尚未有操作记录。", loading:"正在加载总览…" },
};

export default function AdminOverviewPage() {
  const { locale, principal } = useAdmin();
  const [state, setState] = useState<{ loading:boolean; error:string; profiles:any[]; milestones:any[]; teamTrash:any[]; impactTrash:any[]; activity:any[] }>({ loading:true,error:"",profiles:[],milestones:[],teamTrash:[],impactTrash:[],activity:[] });
  useEffect(() => { let active=true; (async()=>{ try {
    const [team,impact,teamTrash,impactTrash,activity] = await Promise.all([
      adminFetch<any>("/api/team-profiles?includeDrafts=true"), adminFetch<any>("/api/impact-milestones?includeDrafts=true"),
      adminFetch<any>("/api/team-profiles?includeDeleted=true"), adminFetch<any>("/api/impact-milestones?includeArchived=true"),
      principal.role === "owner" ? adminFetch<any>("/api/admin/activity?limit=12") : Promise.resolve({activity:[]}),
    ]);
    if(active) setState({loading:false,error:"",profiles:[...(team.leaders||[]),...(team.tutors||[])],milestones:impact.milestones||[],teamTrash:[...(teamTrash.leaders||[]),...(teamTrash.tutors||[])],impactTrash:impactTrash.milestones||[],activity:activity.activity||[]});
  } catch(error){ if(active) setState(s=>({...s,loading:false,error:displayError(error,locale)})); }})(); return()=>{active=false}; },[locale,principal.role]);
  const text=copy[locale]; const all=[...state.profiles,...state.milestones];
  return <section className="admin-page"><header className="admin-page-head"><div><h1>{text.title}</h1><p>{text.intro}</p></div></header>
    {state.error&&<p className="admin-alert" role="alert">{state.error}</p>}
    {state.loading?<p>{text.loading}</p>:<>
      <div className="admin-stat-grid">
        <div className="admin-stat"><strong>{all.filter(x=>x.status==="draft").length}</strong><span>{text.drafts}</span></div>
        <div className="admin-stat"><strong>{all.filter(x=>x.status==="published").length}</strong><span>{text.published}</span></div>
        <div className="admin-stat"><strong>{state.teamTrash.length+state.impactTrash.length}</strong><span>{text.trash}</span></div>
        <div className="admin-stat"><strong>{all.length}</strong><span>{text.total}</span></div>
      </div>
      {principal.role==="owner"&&<div className="admin-panel"><h2>{text.recent}</h2>{state.activity.length?<div className="admin-table-wrap"><table className="admin-table"><tbody>{state.activity.map(item=><tr key={item.id}><td><strong>{item.action}</strong><br/><small>{item.entityType} · {item.entityId}</small></td><td>{item.actorEmail}</td><td>{new Date(item.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>:<p className="admin-muted">{text.noActivity}</p>}</div>}
    </>}
  </section>;
}
