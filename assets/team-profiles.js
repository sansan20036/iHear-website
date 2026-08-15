(function () {
  "use strict";
  const leaderMount = document.querySelector("[data-team-leaders]");
  const tutorMount = document.querySelector("[data-team-tutors]");
  if (!leaderMount || !tutorMount) return;

  const textFields = ["role", "schoolDisplay", "languages", "strengths", "summary", "bio", "hobbies"];
  const locales = ["zhHant", "zhHans", "en"];
  const labels = {
    en:{manager:"Team directory manager",hint:"Drag a handle to reorder profiles, or use the Move buttons. Changes are saved automatically.",editMode:"Manage profiles",done:"Done",add:"Add profile",edit:"Edit",drag:"Drag to reorder",up:"Move up",down:"Move down",draft:"Draft",loading:"Loading team profiles…",empty:"No published profiles yet.",failed:"Team profiles are temporarily unavailable.",newTitle:"Add team profile",editTitle:"Edit team profile",name:"Name",initials:"Initials",section:"Section",leader:"Leadership",tutor:"Tutor",existing:"Existing person",newPerson:"Create a new person",school:"School",grade:"Grade",showSchool:"Show school publicly",showGrade:"Show grade publicly",consent:"I confirm that applicable publication consent has been obtained.",shared:"Changing the name or initials updates this person everywhere.",role:"Role / title",schoolDisplay:"Localized school name",languages:"Languages",strengths:"Teaching strengths",summary:"Short introduction",bio:"Full bio",hobbies:"Hobbies",saveDraft:"Save draft",publish:"Publish",cancel:"Cancel",delete:"Permanently delete",deleteConfirm:"Permanently delete this profile placement? This cannot be undone.",conflict:"Someone else changed this data. Reload and try again.",saved:"Team profile saved.",orderSaved:"Team order saved.",reorderFailed:"Unable to save the new order. Please try again.",deleted:"Team profile deleted.",validation:"Please review the form.",copy:"Copy English",close:"Close editor",unsaved:"Discard your unsaved team-profile changes?",retry:"Retry",moved:(name,position,total)=>`${name} moved to position ${position} of ${total}.`},
    zhHant:{manager:"團隊資料管理",hint:"拖曳卡片上的排序把手，或使用上移／下移按鈕；放開後會自動儲存。",editMode:"管理團隊檔案",done:"完成",add:"新增檔案",edit:"編輯",drag:"拖曳排序",up:"上移",down:"下移",draft:"草稿",loading:"正在載入團隊資料…",empty:"目前沒有已發布的團隊檔案。",failed:"目前無法載入團隊資料。",newTitle:"新增團隊檔案",editTitle:"編輯團隊檔案",name:"姓名",initials:"姓名縮寫",section:"顯示區塊",leader:"領導團隊",tutor:"導師",existing:"既有人物",newPerson:"建立新人物",school:"學校",grade:"年級",showSchool:"公開顯示學校",showGrade:"公開顯示年級",consent:"我確認已取得適用的公開同意。",shared:"修改姓名或縮寫會同步套用到此人物的所有版位。",role:"角色／職稱",schoolDisplay:"本語言的學校名稱",languages:"使用語言",strengths:"教學專長",summary:"簡短介紹",bio:"完整介紹",hobbies:"興趣",saveDraft:"儲存草稿",publish:"發布",cancel:"取消",delete:"永久刪除",deleteConfirm:"確定要永久刪除此公開版位嗎？刪除後無法復原。",conflict:"另一位管理員已修改資料，請重新載入後再試。",saved:"團隊檔案已儲存。",orderSaved:"團隊順序已儲存。",reorderFailed:"無法儲存新順序，請稍後再試。",deleted:"團隊檔案已刪除。",validation:"請檢查表單內容。",copy:"複製英文",close:"關閉編輯器",unsaved:"要放棄尚未儲存的團隊檔案修改嗎？",retry:"重試",moved:(name,position,total)=>`${name} 已移到第 ${position} 位，共 ${total} 位。`},
    zhHans:{manager:"团队数据管理",hint:"拖动卡片上的排序把手，或使用上移／下移按钮；放开后会自动保存。",editMode:"管理团队档案",done:"完成",add:"新增档案",edit:"编辑",drag:"拖动排序",up:"上移",down:"下移",draft:"草稿",loading:"正在加载团队数据…",empty:"目前没有已发布的团队档案。",failed:"目前无法加载团队数据。",newTitle:"新增团队档案",editTitle:"编辑团队档案",name:"姓名",initials:"姓名缩写",section:"显示区块",leader:"领导团队",tutor:"导师",existing:"现有人物",newPerson:"建立新人物",school:"学校",grade:"年级",showSchool:"公开显示学校",showGrade:"公开显示年级",consent:"我确认已取得适用的公开同意。",shared:"修改姓名或缩写会同步套用到此人物的所有版位。",role:"角色／职称",schoolDisplay:"本语言的学校名称",languages:"使用语言",strengths:"教学专长",summary:"简短介绍",bio:"完整介绍",hobbies:"兴趣",saveDraft:"保存草稿",publish:"发布",cancel:"取消",delete:"永久删除",deleteConfirm:"确定要永久删除此公开版位吗？删除后无法恢复。",conflict:"另一位管理员已修改数据，请重新加载后再试。",saved:"团队档案已保存。",orderSaved:"团队顺序已保存。",reorderFailed:"无法保存新顺序，请稍后再试。",deleted:"团队档案已删除。",validation:"请检查表单内容。",copy:"复制英文",close:"关闭编辑器",unsaved:"要放弃尚未保存的团队档案修改吗？",retry:"重试",moved:(name,position,total)=>`${name} 已移到第 ${position} 位，共 ${total} 位。`}
  };
  const state={leaders:[],tutors:[],people:[],admin:false,editMode:false,busy:false,reordering:false,deleteConfirming:false,draft:null,originalDraft:"",activeLocale:"zhHant"};
  const adminBar=document.createElement("div"),dialog=document.createElement("dialog"),toast=document.createElement("div");
  adminBar.className="team-directory-admin";adminBar.hidden=true;adminBar.setAttribute("data-no-inline-edit","");
  leaderMount.parentElement.insertBefore(adminBar,leaderMount);
  dialog.className="team-profile-editor";dialog.setAttribute("data-no-inline-edit","");dialog.setAttribute("aria-modal","true");dialog.setAttribute("aria-labelledby","team-editor-title");document.body.appendChild(dialog);
  toast.className="team-profile-toast";toast.hidden=true;toast.setAttribute("role","status");toast.setAttribute("aria-live","polite");document.body.appendChild(toast);
  let toastTimer;

  function locale(){const lang=(document.documentElement.lang||"en").toLowerCase();return lang.includes("hans")?"zhHans":lang.startsWith("zh")?"zhHant":"en"}
  function l(){return labels[locale()]}
  function esc(value){return String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}
  function pick(value){const key=locale();return value&&String(value[key]||value.en||"").trim()||""}
  function showToast(message,error){clearTimeout(toastTimer);toast.textContent=message;toast.dataset.error=String(Boolean(error));toast.hidden=false;toastTimer=setTimeout(()=>toast.hidden=true,3500)}
  function message(mount,text){mount.innerHTML=`<p class="team-directory-message">${esc(text)}</p>`}
  function all(section){return state[section==="leader"?"leaders":"tutors"]}
  function visible(items){return state.admin&&state.editMode?items:items.filter(item=>item.status!=="draft")}
  function dragHandle(item){
    if(!state.admin||!state.editMode)return"";
    return `<button type="button" class="team-profile-drag-handle" data-team-drag="${esc(item.section)}" data-drag-id="${esc(item.id)}" aria-label="${esc(l().drag)}: ${esc(item.name)}" aria-keyshortcuts="ArrowUp ArrowDown" ${state.reordering?"disabled":""}><span aria-hidden="true">⠇⠇</span><span class="team-profile-drag-text">${esc(l().drag)}</span></button>`;
  }

  function avatarSlot(personId){
    if(personId==="person-howard-m-ren")return "team.howard-ren.avatar";
    const identifier=String(personId||"").toLowerCase().replace(/^person-/,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
    return identifier?`team.${identifier}.avatar`:"";
  }

  function avatar(item,sizeClass=""){
    const slot=avatarSlot(item.personId);
    const classes=`avatar${sizeClass?` ${sizeClass}`:""} team-avatar-slot`;
    const altEn=`Portrait of ${item.name}`;
    const altZhHant=`${item.name} 的個人頭像`;
    const altZhHans=`${item.name} 的个人头像`;
    return `<span class="${classes}" data-site-media-slot="${esc(slot)}" data-site-media-kind="avatar" data-site-media-aspect="1 / 1" data-site-media-alt-en="${esc(altEn)}" data-site-media-alt-zh-hant="${esc(altZhHant)}" data-site-media-alt-zh-hans="${esc(altZhHans)}" data-no-inline-edit>
      <span class="team-avatar-visual"><span class="avatar-initials" aria-hidden="true">${esc(item.initials)}</span><picture hidden><source type="image/webp"><img alt="" loading="lazy" decoding="async"></picture></span>
    </span>`;
  }

  function leaderCard(item,index,items){
    const draft=item.status==="draft"?`<span class="team-profile-status">${l().draft}</span>`:"";
    return `<article class="leader team-profile-admin-card" data-profile-id="${esc(item.id)}" data-status="${esc(item.status)}">
      ${dragHandle(item)}${avatar(item)}<h2>${esc(item.name)}${draft}</h2>
      <p class="roles">${esc(pick(item.role))}</p><p>${esc(pick(item.bio))}</p>
      ${actions(item,index,items)}</article>`;
  }
  function tutorCard(item,index,items){
    const meta=[item.showSchool?(pick(item.schoolDisplay)||item.school):"",item.showGrade?(locale()==="en"?`Grade ${item.grade}`:`${item.grade} 年級`):""].filter(Boolean).join(" · ");
    const draft=item.status==="draft"?`<span class="team-profile-status">${l().draft}</span>`:"";
    return `<article class="team-profile-tutor-shell team-profile-admin-card" data-profile-id="${esc(item.id)}" data-status="${esc(item.status)}">
      ${dragHandle(item)}<details class="tutor-prof"><summary>${avatar(item,"av-sm")}
      <span class="tp-id"><b>${esc(item.name)}${draft}</b><i>${esc(pick(item.role))}</i></span>
      <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.4 8.6L12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg></summary>
      <div class="tp-body">${meta?`<p class="tp-meta">${esc(meta)}</p>`:""}
      ${pick(item.languages)?`<p class="tp-langs">${esc(pick(item.languages))}</p>`:""}
      ${pick(item.strengths)?`<p class="tp-tags">${esc(pick(item.strengths))}</p>`:""}
      <p class="tp-lead">${esc(pick(item.summary))}</p><p>${esc(pick(item.bio))}</p>
      ${pick(item.hobbies)?`<p class="tp-hob">${esc(pick(item.hobbies))}</p>`:""}</div>
      ${actions(item,index,items)}</details></article>`;
  }
  function actions(item,index,items){
    if(!state.admin||!state.editMode)return"";
    return `<div class="team-card-actions">
      <button class="team-admin-button" data-edit="${esc(item.id)}" ${state.reordering?"disabled":""}>${l().edit}</button>
      <button class="team-admin-button" data-move="${esc(item.id)}" data-direction="-1" ${index===0||state.reordering?"disabled":""}>↑ ${l().up}</button>
      <button class="team-admin-button" data-move="${esc(item.id)}" data-direction="1" ${index===items.length-1||state.reordering?"disabled":""}>↓ ${l().down}</button>
    </div>`;
  }
  function render(){
    const openTutorIds=new Set(Array.from(tutorMount.querySelectorAll(".team-profile-tutor-shell > details[open]")).map(item=>item.parentElement.dataset.profileId));
    const scrollY=window.scrollY;
    [["leader",leaderMount,leaderCard],["tutor",tutorMount,tutorCard]].forEach(([section,mount,card])=>{
      const items=visible(all(section));
      if(!items.length){message(mount,l().empty);return}
      mount.innerHTML=items.map((item,index)=>card(item,index,items)).join("");
    });
    adminBar.hidden=!state.admin;
    if(state.admin)adminBar.innerHTML=`<div><strong>${l().manager}</strong><span>${l().hint}</span></div><div class="team-admin-actions">
      ${state.editMode?`<button class="team-admin-button accent" data-team-add>${l().add}</button>`:""}
      <button class="team-admin-button primary" data-team-toggle>${state.editMode?l().done:l().editMode}</button></div>`;
    openTutorIds.forEach(id=>{const item=tutorMount.querySelector(`[data-profile-id="${CSS.escape(id)}"] > details`);if(item)item.open=true});
    if(openTutorIds.size)window.requestAnimationFrame(()=>window.scrollTo(window.scrollX,scrollY));
    window.dispatchEvent(new CustomEvent("ihear:media-slots-changed"));
  }
  function emptyLocalized(){return{en:"",zhHant:"",zhHans:""}}
  function newDraft(){
    const draft={personId:"",name:"",initials:"",section:"tutor",status:"draft",sortOrder:0,school:"",grade:"",showSchool:false,showGrade:false,consentConfirmed:false};
    textFields.forEach(field=>draft[field]=emptyLocalized());return draft
  }
  function openEditor(item){
    state.draft=item?JSON.parse(JSON.stringify({...item,consentConfirmed:Boolean(item.publicationConsentAt)})):newDraft();
    state.originalDraft=JSON.stringify(state.draft);state.activeLocale=locale();state.deleteConfirming=false;buildEditor();dialog.showModal();document.body.classList.add("team-profile-modal-open");dialog.querySelector("input,select,textarea,button")?.focus()
  }
  function isDirty(){if(!state.draft)return false;syncDraft();return JSON.stringify(state.draft)!==state.originalDraft}
  function closeEditor(force){if(!dialog.open)return true;if(!force&&isDirty()&&!confirm(l().unsaved))return false;dialog.close();return true}
  function field(name,label,textarea){
    const value=state.draft[name]||"";
    return `<div class="team-field"><label for="team-${name}">${label}</label>${textarea?`<textarea id="team-${name}" name="${name}">${esc(value)}</textarea>`:`<input id="team-${name}" name="${name}" value="${esc(value)}">`}<span data-error="${name}"></span></div>`
  }
  function localField(name,label,textarea){
    const value=state.draft[name]&&state.draft[name][state.activeLocale]||"";
    return `<div class="team-field"><label for="team-${name}-${state.activeLocale}">${label}</label>${textarea?`<textarea id="team-${name}-${state.activeLocale}" name="${name}.${state.activeLocale}">${esc(value)}</textarea>`:`<input id="team-${name}-${state.activeLocale}" name="${name}.${state.activeLocale}" value="${esc(value)}">`}<span data-error="${name}.${state.activeLocale}"></span></div>`
  }
  function complete(key){return textFields.some(field=>state.draft[field]&&state.draft[field][key])}
  function buildEditor(){
    const labelsForLocale={zhHant:"繁體中文",zhHans:"简体中文",en:"English"};
    const peopleOptions=state.people.map(person=>`<option value="${esc(person.id)}" ${state.draft.personId===person.id?"selected":""}>${esc(person.name)}</option>`).join("");
    dialog.innerHTML=`<div class="team-editor-shell"><header class="team-editor-head"><div><h3 id="team-editor-title">${state.draft.id?l().editTitle:l().newTitle}</h3><small>${l().shared}</small></div><button type="button" class="team-admin-button" data-close aria-label="${esc(l().close)}">×</button></header>
    <form data-team-form><div class="team-editor-body"><div class="team-basic-grid">
      ${state.draft.id?"":`<div class="team-field wide"><label for="team-personId">${l().existing}</label><select id="team-personId" name="personId"><option value="">${l().newPerson}</option>${peopleOptions}</select></div>`}
      ${field("name",l().name)}${field("initials",l().initials)}
      <div class="team-field"><label for="team-section">${l().section}</label><select id="team-section" name="section"><option value="leader" ${state.draft.section==="leader"?"selected":""}>${l().leader}</option><option value="tutor" ${state.draft.section==="tutor"?"selected":""}>${l().tutor}</option></select></div>
      ${field("school",l().school)}${field("grade",l().grade)}
      <label class="team-check"><input type="checkbox" name="showSchool" ${state.draft.showSchool?"checked":""}>${l().showSchool}</label>
      <label class="team-check"><input type="checkbox" name="showGrade" ${state.draft.showGrade?"checked":""}>${l().showGrade}</label>
      <label class="team-check team-field wide"><input type="checkbox" name="consentConfirmed" ${state.draft.consentConfirmed?"checked":""}>${l().consent}</label>
    </div>
    <div class="team-locale-tabs" role="tablist" aria-label="${esc(l().shared)}">${locales.map(key=>`<button type="button" id="team-tab-${key}" class="team-locale-tab" role="tab" data-locale="${key}" data-complete="${complete(key)}" aria-selected="${state.activeLocale===key}" aria-controls="team-panel-${key}" tabindex="${state.activeLocale===key?0:-1}"><span class="team-locale-dot"></span>${labelsForLocale[key]}</button>`).join("")}</div>
    <div class="team-locale-panel" id="team-panel-${state.activeLocale}" role="tabpanel" aria-labelledby="team-tab-${state.activeLocale}">${localField("role",l().role)}${localField("schoolDisplay",l().schoolDisplay)}${localField("languages",l().languages)}${localField("strengths",l().strengths,true)}${localField("summary",l().summary,true)}${localField("bio",l().bio,true)}${localField("hobbies",l().hobbies,true)}${state.activeLocale!=="en"?`<button type="button" class="team-admin-button" data-copy-en>${l().copy}</button>`:""}</div>
    <p class="team-form-error" data-form-error role="alert" tabindex="-1" hidden></p></div>
    <footer class="team-editor-footer">${state.deleteConfirming?`<div class="team-delete-confirm" role="group" aria-labelledby="team-delete-confirm-message"><p id="team-delete-confirm-message">${esc(l().deleteConfirm)}</p><div class="team-editor-actions"><button type="button" class="team-admin-button" data-delete-cancel>${l().cancel}</button><button type="button" class="team-admin-button danger" data-delete-confirm>${l().delete}</button></div></div>`:`<div>${state.draft.id?`<button type="button" class="team-admin-button danger" data-delete>${l().delete}</button>`:""}</div><div class="team-editor-actions"><button type="button" class="team-admin-button" data-cancel>${l().cancel}</button><button type="button" class="team-admin-button primary" data-save="draft">${l().saveDraft}</button><button type="button" class="team-admin-button accent" data-save="published">${l().publish}</button></div>`}</footer></form></div>`;
  }
  function syncDraft(){
    const form=dialog.querySelector("[data-team-form]");if(!form)return;
    new FormData(form).forEach((value,key)=>{if(key.includes(".")){const [field,lang]=key.split(".");state.draft[field][lang]=String(value)}else state.draft[key]=String(value)});
    ["showSchool","showGrade","consentConfirmed"].forEach(key=>state.draft[key]=form.elements[key].checked);
  }
  function payload(status){
    syncDraft();return{...state.draft,status,sortOrder:Number(state.draft.sortOrder||0),profileVersion:state.draft.profileVersion,personVersion:state.draft.personVersion}
  }
  function errorFrom(response,data){const error=new Error(data&&data.error||l().validation);error.status=response.status;error.issues=data&&data.issues;return error}
  function setBusy(busy){state.busy=busy;const shell=dialog.querySelector(".team-editor-shell");if(shell)shell.setAttribute("aria-busy",String(busy));dialog.querySelectorAll("button,input,select,textarea").forEach(control=>control.disabled=busy)}
  function showIssues(error){
    const issues=error&&error.issues||{};
    const issueLocale=Object.keys(issues).map(key=>key.split(".")[1]).find(key=>locales.includes(key));
    if(issueLocale&&issueLocale!==state.activeLocale){state.activeLocale=issueLocale;buildEditor()}
    const box=dialog.querySelector("[data-form-error]");
    dialog.querySelectorAll("[data-error]").forEach(node=>{node.textContent=""});
    let first=null;
    Object.entries(issues).forEach(([key,value])=>{
      const marker=dialog.querySelector(`[data-error="${CSS.escape(key)}"]`);
      const field=dialog.querySelector(`[name="${CSS.escape(key)}"]`);
      if(marker)marker.textContent=value;
      if(field){field.setAttribute("aria-invalid","true");if(!first)first=field}
    });
    box.hidden=false;box.textContent=error.status===409?l().conflict:(Object.values(issues).join(" · ")||error.message||l().validation);
    (first||box).focus();
  }
  async function save(status){
    if(state.busy)return;const body=payload(status);setBusy(true);
    try{
      const response=await fetch(state.draft.id?`/api/team-profiles/${encodeURIComponent(state.draft.id)}`:"/api/team-profiles",{method:state.draft.id?"PATCH":"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const data=await response.json().catch(()=>null);if(!response.ok)throw errorFrom(response,data);
      state.originalDraft=JSON.stringify(state.draft);closeEditor(true);await load(true,{revision:data.revision&&data.revision.revision});showToast(l().saved,false);if(window.iHearLiveContent)window.iHearLiveContent.announce("team",data.revision)
    }catch(error){setBusy(false);showIssues(error)}
  }
  function requestRemove(){
    if(state.busy||!state.draft.id)return;syncDraft();state.deleteConfirming=true;buildEditor();requestAnimationFrame(()=>dialog.querySelector("[data-delete-confirm]")?.focus())
  }
  function cancelRemove(){
    if(state.busy)return;state.deleteConfirming=false;buildEditor();requestAnimationFrame(()=>dialog.querySelector("[data-delete]")?.focus())
  }
  async function remove(){
    if(state.busy||!state.draft.id||!state.deleteConfirming)return;setBusy(true);
    try{
      const response=await fetch(`/api/team-profiles/${encodeURIComponent(state.draft.id)}`,{method:"DELETE",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({profileVersion:state.draft.profileVersion})});
      const data=await response.json().catch(()=>null);if(!response.ok)throw errorFrom(response,data);
      state.originalDraft=JSON.stringify(state.draft);closeEditor(true);await load(true,{revision:data.revision&&data.revision.revision});showToast(l().deleted,false);if(window.iHearLiveContent)window.iHearLiveContent.announce("team",data.revision)
    }catch(error){setBusy(false);showIssues(error);showToast(error.status===409?l().conflict:error.message||l().validation,true)}
  }
  async function persistOrder(section,nextItems,focusId){
    if(state.reordering)return;
    const key=section==="leader"?"leaders":"tutors",previous=[...state[key]];
    state[key]=nextItems;state.reordering=true;render();
    try{
      const response=await fetch("/api/team-profiles/reorder",{method:"PATCH",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({section,ordered:nextItems.map(profile=>({id:profile.id,version:profile.profileVersion}))})});
      const data=await response.json().catch(()=>null);if(!response.ok)throw errorFrom(response,data);
      state.reordering=false;await load(true,{revision:data.revision&&data.revision.revision});
      if(focusId){const moved=nextItems.find(profile=>profile.id===focusId),position=nextItems.findIndex(profile=>profile.id===focusId)+1;requestAnimationFrame(()=>document.querySelector(`[data-drag-id="${CSS.escape(focusId)}"]`)?.focus());showToast(`${l().orderSaved} ${l().moved(moved&&moved.name||"",position,nextItems.length)}`,false)}else showToast(l().orderSaved,false);
      if(window.iHearLiveContent)window.iHearLiveContent.announce("team",data.revision)
    }catch(error){
      state.reordering=false;state[key]=previous;render();showToast(error.status===409?l().conflict:l().reorderFailed,true);
      await load(true).catch(()=>{state[key]=previous;render()})
    }
  }
  function move(id,direction){
    const item=[...state.leaders,...state.tutors].find(profile=>profile.id===id);if(!item)return;
    const items=[...all(item.section)],index=items.findIndex(profile=>profile.id===id),target=index+direction;if(target<0||target>=items.length)return;
    [items[index],items[target]]=[items[target],items[index]];return persistOrder(item.section,items,id)
  }

  let dragState=null;
  function finishDrag(save){
    if(!dragState)return;
    const current=dragState;
    current.card.classList.remove("team-profile-dragging");current.handle.setAttribute("aria-pressed","false");document.body.classList.remove("team-profile-reordering");dragState=null;
    if(!current.moved||!save){if(current.moved)render();return}
    const ids=Array.from(current.mount.querySelectorAll(":scope > [data-profile-id]")).map(card=>card.dataset.profileId);
    if(ids.join("|")===current.originalIds.join("|")){render();return}
    const byId=new Map(all(current.section).map(item=>[item.id,item]));const nextItems=ids.map(id=>byId.get(id)).filter(Boolean);
    if(nextItems.length!==byId.size){render();return}
    persistOrder(current.section,nextItems)
  }
  document.addEventListener("pointerdown",event=>{
    const handle=event.target.closest("[data-team-drag]");if(!handle||state.reordering||event.button!==0)return;
    const card=handle.closest("[data-profile-id]"),section=handle.dataset.teamDrag,mount=section==="leader"?leaderMount:tutorMount;if(!card||!mount.contains(card))return;
    dragState={pointerId:event.pointerId,handle,card,mount,section,startX:event.clientX,startY:event.clientY,moved:false,originalIds:Array.from(mount.querySelectorAll(":scope > [data-profile-id]")).map(item=>item.dataset.profileId)};
    handle.setPointerCapture&&handle.setPointerCapture(event.pointerId);event.preventDefault();event.stopPropagation()
  });
  document.addEventListener("pointermove",event=>{
    if(!dragState||dragState.pointerId!==event.pointerId)return;
    if(!dragState.moved&&Math.hypot(event.clientX-dragState.startX,event.clientY-dragState.startY)<6)return;
    if(!dragState.moved){dragState.moved=true;dragState.card.classList.add("team-profile-dragging");dragState.handle.setAttribute("aria-pressed","true");document.body.classList.add("team-profile-reordering")}
    event.preventDefault();
    const element=document.elementFromPoint(event.clientX,event.clientY),target=element&&element.closest("[data-profile-id]");
    if(target&&target!==dragState.card&&dragState.mount.contains(target)){
      const bounds=target.getBoundingClientRect(),before=event.clientY<bounds.top+bounds.height/2;
      dragState.mount.insertBefore(dragState.card,before?target:target.nextElementSibling)
    }
    const edge=72;if(event.clientY<edge)window.scrollBy(0,-16);else if(event.clientY>window.innerHeight-edge)window.scrollBy(0,16)
  },{passive:false});
  document.addEventListener("pointerup",event=>{if(dragState&&dragState.pointerId===event.pointerId){event.preventDefault();finishDrag(true)}});
  document.addEventListener("pointercancel",event=>{if(dragState&&dragState.pointerId===event.pointerId)finishDrag(false)});
  document.addEventListener("keydown",event=>{
    const handle=event.target.closest("[data-team-drag]");if(!handle||!['ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();move(handle.dataset.dragId,event.key==='ArrowUp'?-1:1)
  });
  let loadSequence=0;
  async function load(admin,context){
    const sequence=++loadSequence;
    try{
      const parameters=new URLSearchParams();if(admin)parameters.set("includeDrafts","true");if(context&&context.revision)parameters.set("live",context.revision);const query=parameters.toString();
      const response=await fetch(`/api/team-profiles${query?`?${query}`:""}`,{credentials:"same-origin",cache:"no-store"});
      if(!response.ok)throw new Error("load");const data=await response.json();if(sequence!==loadSequence)return;
      state.leaders=Array.isArray(data.leaders)?data.leaders:[];state.tutors=Array.isArray(data.tutors)?data.tutors:[];state.people=Array.isArray(data.people)?data.people:[];state.admin=Boolean(data.admin)||state.admin;state.busy=false;render()
    }catch(error){if(sequence!==loadSequence)return;if(!state.leaders.length&&!state.tutors.length){const failure=`<p class="team-directory-message">${esc(l().failed)}</p><button type="button" class="team-admin-button" data-team-retry>${esc(l().retry)}</button>`;leaderMount.innerHTML=failure;tutorMount.innerHTML=failure}if(context)throw error}
  }
  document.addEventListener("click",event=>{
    const button=event.target.closest("button");if(!button)return;
    if(button.matches("[data-team-drag]")){event.preventDefault();event.stopPropagation()}
    else if(button.matches("[data-team-toggle]")){state.editMode=!state.editMode;render()}
    else if(button.matches("[data-team-add]"))openEditor(null);
    else if(button.dataset.edit)openEditor([...state.leaders,...state.tutors].find(item=>item.id===button.dataset.edit));
    else if(button.dataset.move)move(button.dataset.move,Number(button.dataset.direction));
    else if(button.matches("[data-team-retry]")){message(leaderMount,l().loading);message(tutorMount,l().loading);load(state.admin)}
    else if(button.matches("[data-close],[data-cancel]"))closeEditor();
    else if(button.dataset.save)save(button.dataset.save);
    else if(button.matches("[data-delete]"))requestRemove();
    else if(button.matches("[data-delete-cancel]"))cancelRemove();
    else if(button.matches("[data-delete-confirm]"))remove();
    else if(button.dataset.locale){syncDraft();state.activeLocale=button.dataset.locale;buildEditor()}
    else if(button.matches("[data-copy-en]")){syncDraft();textFields.forEach(field=>state.draft[field][state.activeLocale]=state.draft[field].en);buildEditor()}
  });
  dialog.addEventListener("input",event=>{if(event.target.name){syncDraft();event.target.removeAttribute("aria-invalid");const marker=dialog.querySelector(`[data-error="${CSS.escape(event.target.name)}"]`);if(marker)marker.textContent=""}});
  dialog.addEventListener("cancel",event=>{event.preventDefault();if(!state.busy)closeEditor()});
  dialog.addEventListener("keydown",event=>{
    const tab=event.target.closest('[role="tab"][data-locale]');if(!tab)return;
    const tabs=Array.from(dialog.querySelectorAll('[role="tab"][data-locale]'));let index=tabs.indexOf(tab);
    if(event.key==="ArrowRight"||event.key==="ArrowDown")index=(index+1)%tabs.length;
    else if(event.key==="ArrowLeft"||event.key==="ArrowUp")index=(index-1+tabs.length)%tabs.length;
    else if(event.key==="Home")index=0;else if(event.key==="End")index=tabs.length-1;else return;
    event.preventDefault();syncDraft();state.activeLocale=tabs[index].dataset.locale;buildEditor();dialog.querySelector(`[data-locale="${state.activeLocale}"]`)?.focus()
  });
  dialog.addEventListener("change",event=>{
    if(event.target.name!=="personId")return;
    syncDraft();
    const person=state.people.find(item=>item.id===state.draft.personId);
    if(person){
      state.draft.name=person.name;
      state.draft.initials=person.initials;
      state.draft.consentConfirmed=Boolean(person.consentConfirmed);
      buildEditor();
    }
  });
  dialog.addEventListener("close",()=>{document.body.classList.remove("team-profile-modal-open");state.draft=null;state.originalDraft="";state.busy=false;state.deleteConfirming=false;if(window.iHearLiveContent)window.iHearLiveContent.checkNow({force:true})});
  window.addEventListener("ihear:before-language",event=>{if(dialog.open&&isDirty()){if(!confirm(l().unsaved))event.preventDefault();else closeEditor(true)}});
  window.addEventListener("ihear:language",()=>{render();if(dialog.open){syncDraft();buildEditor()}});
  window.addEventListener("beforeunload",event=>{if(!isDirty())return;event.preventDefault();event.returnValue=""});
  window.addEventListener("ihear:auth",event=>{const session=event.detail&&event.detail.session;if(session&&session.user&&session.user.isAdmin){state.admin=true;load(true)}else{state.admin=false;state.editMode=false;load(false)}});
  window.iHearTeamProfiles={refresh:context=>load(state.admin,context),isDirty};
  if(window.iHearLiveContent)window.iHearLiveContent.register("team",{refresh:context=>load(state.admin,context),isDirty,onBlocked:()=>showToast(l().conflict,true)});
  message(leaderMount,l().loading);message(tutorMount,l().loading);load(false);
})();
