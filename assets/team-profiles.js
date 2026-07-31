(function () {
  "use strict";
  const leaderMount = document.querySelector("[data-team-leaders]");
  const tutorMount = document.querySelector("[data-team-tutors]");
  if (!leaderMount || !tutorMount) return;

  const textFields = ["role", "schoolDisplay", "languages", "strengths", "summary", "bio", "hobbies"];
  const locales = ["zhHant", "zhHans", "en"];
  const labels = {
    en:{manager:"Team directory manager",hint:"Add, edit, publish, delete, and reorder public profiles.",editMode:"Manage profiles",done:"Done",add:"Add profile",edit:"Edit",up:"Move up",down:"Move down",draft:"Draft",loading:"Loading team profiles…",empty:"No published profiles yet.",failed:"Team profiles are temporarily unavailable.",newTitle:"Add team profile",editTitle:"Edit team profile",name:"Name",initials:"Initials",section:"Section",leader:"Leadership",tutor:"Tutor",existing:"Existing person",newPerson:"Create a new person",school:"School",grade:"Grade",showSchool:"Show school publicly",showGrade:"Show grade publicly",consent:"I confirm that applicable publication consent has been obtained.",shared:"Changing the name or initials updates this person everywhere.",role:"Role / title",schoolDisplay:"Localized school name",languages:"Languages",strengths:"Teaching strengths",summary:"Short introduction",bio:"Full bio",hobbies:"Hobbies",saveDraft:"Save draft",publish:"Publish",cancel:"Cancel",delete:"Permanently delete",deleteConfirm:"Permanently delete this profile placement? This cannot be undone.",conflict:"Someone else changed this data. Reload and try again.",saved:"Team profile saved.",deleted:"Team profile deleted.",validation:"Please review the form.",copy:"Copy English"},
    zhHant:{manager:"團隊資料管理",hint:"新增、編輯、發布、刪除及排序公開團隊檔案。",editMode:"管理團隊檔案",done:"完成",add:"新增檔案",edit:"編輯",up:"上移",down:"下移",draft:"草稿",loading:"正在載入團隊資料…",empty:"目前沒有已發布的團隊檔案。",failed:"目前無法載入團隊資料。",newTitle:"新增團隊檔案",editTitle:"編輯團隊檔案",name:"姓名",initials:"姓名縮寫",section:"顯示區塊",leader:"領導團隊",tutor:"導師",existing:"既有人物",newPerson:"建立新人物",school:"學校",grade:"年級",showSchool:"公開顯示學校",showGrade:"公開顯示年級",consent:"我確認已取得適用的公開同意。",shared:"修改姓名或縮寫會同步套用到此人物的所有版位。",role:"角色／職稱",schoolDisplay:"本語言的學校名稱",languages:"使用語言",strengths:"教學專長",summary:"簡短介紹",bio:"完整介紹",hobbies:"興趣",saveDraft:"儲存草稿",publish:"發布",cancel:"取消",delete:"永久刪除",deleteConfirm:"確定要永久刪除此公開版位嗎？刪除後無法復原。",conflict:"另一位管理員已修改資料，請重新載入後再試。",saved:"團隊檔案已儲存。",deleted:"團隊檔案已刪除。",validation:"請檢查表單內容。",copy:"複製英文"},
    zhHans:{manager:"团队数据管理",hint:"新增、编辑、发布、删除及排序公开团队档案。",editMode:"管理团队档案",done:"完成",add:"新增档案",edit:"编辑",up:"上移",down:"下移",draft:"草稿",loading:"正在加载团队数据…",empty:"目前没有已发布的团队档案。",failed:"目前无法加载团队数据。",newTitle:"新增团队档案",editTitle:"编辑团队档案",name:"姓名",initials:"姓名缩写",section:"显示区块",leader:"领导团队",tutor:"导师",existing:"现有人物",newPerson:"建立新人物",school:"学校",grade:"年级",showSchool:"公开显示学校",showGrade:"公开显示年级",consent:"我确认已取得适用的公开同意。",shared:"修改姓名或缩写会同步套用到此人物的所有版位。",role:"角色／职称",schoolDisplay:"本语言的学校名称",languages:"使用语言",strengths:"教学专长",summary:"简短介绍",bio:"完整介绍",hobbies:"兴趣",saveDraft:"保存草稿",publish:"发布",cancel:"取消",delete:"永久删除",deleteConfirm:"确定要永久删除此公开版位吗？删除后无法恢复。",conflict:"另一位管理员已修改数据，请重新加载后再试。",saved:"团队档案已保存。",deleted:"团队档案已删除。",validation:"请检查表单内容。",copy:"复制英文"}
  };
  const state={leaders:[],tutors:[],people:[],admin:false,editMode:false,busy:false,draft:null,activeLocale:"zhHant"};
  const adminBar=document.createElement("div"),dialog=document.createElement("dialog"),toast=document.createElement("div");
  adminBar.className="team-directory-admin";adminBar.hidden=true;adminBar.setAttribute("data-no-inline-edit","");
  leaderMount.parentElement.insertBefore(adminBar,leaderMount);
  dialog.className="team-profile-editor";dialog.setAttribute("data-no-inline-edit","");document.body.appendChild(dialog);
  toast.className="team-profile-toast";toast.hidden=true;document.body.appendChild(toast);
  let toastTimer;

  function locale(){const lang=(document.documentElement.lang||"en").toLowerCase();return lang.includes("hans")?"zhHans":lang.startsWith("zh")?"zhHant":"en"}
  function l(){return labels[locale()]}
  function esc(value){return String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}
  function pick(value){const key=locale();return value&&String(value[key]||value.en||"").trim()||""}
  function showToast(message,error){clearTimeout(toastTimer);toast.textContent=message;toast.dataset.error=String(Boolean(error));toast.hidden=false;toastTimer=setTimeout(()=>toast.hidden=true,3500)}
  function message(mount,text){mount.innerHTML=`<p class="team-directory-message">${esc(text)}</p>`}
  function all(section){return state[section==="leader"?"leaders":"tutors"]}
  function visible(items){return state.admin&&state.editMode?items:items.filter(item=>item.status==="published")}

  function leaderCard(item,index,items){
    const draft=item.status==="draft"?`<span class="team-profile-status">${l().draft}</span>`:"";
    return `<article class="leader team-profile-admin-card" data-status="${esc(item.status)}">
      <div class="avatar" aria-hidden="true">${esc(item.initials)}</div><h3>${esc(item.name)}${draft}</h3>
      <p class="roles">${esc(pick(item.role))}</p><p>${esc(pick(item.bio))}</p>
      ${actions(item,index,items)}</article>`;
  }
  function tutorCard(item,index,items){
    const meta=[item.showSchool?(pick(item.schoolDisplay)||item.school):"",item.showGrade?(locale()==="en"?`Grade ${item.grade}`:`${item.grade} 年級`):""].filter(Boolean).join(" · ");
    const draft=item.status==="draft"?`<span class="team-profile-status">${l().draft}</span>`:"";
    return `<details class="tutor-prof team-profile-admin-card" data-status="${esc(item.status)}">
      <summary><span class="avatar av-sm" aria-hidden="true">${esc(item.initials)}</span>
      <span class="tp-id"><b>${esc(item.name)}${draft}</b><i>${esc(pick(item.role))}</i></span>
      <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.4 8.6L12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg></summary>
      <div class="tp-body">${meta?`<p class="tp-meta">${esc(meta)}</p>`:""}
      ${pick(item.languages)?`<p class="tp-langs">${esc(pick(item.languages))}</p>`:""}
      ${pick(item.strengths)?`<p class="tp-tags">${esc(pick(item.strengths))}</p>`:""}
      <p class="tp-lead">${esc(pick(item.summary))}</p><p>${esc(pick(item.bio))}</p>
      ${pick(item.hobbies)?`<p class="tp-hob">${esc(pick(item.hobbies))}</p>`:""}</div>
      ${actions(item,index,items)}</details>`;
  }
  function actions(item,index,items){
    if(!state.admin||!state.editMode)return"";
    return `<div class="team-card-actions">
      <button class="team-admin-button" data-edit="${esc(item.id)}">${l().edit}</button>
      <button class="team-admin-button" data-move="${esc(item.id)}" data-direction="-1" ${index===0?"disabled":""}>↑ ${l().up}</button>
      <button class="team-admin-button" data-move="${esc(item.id)}" data-direction="1" ${index===items.length-1?"disabled":""}>↓ ${l().down}</button>
    </div>`;
  }
  function render(){
    [["leader",leaderMount,leaderCard],["tutor",tutorMount,tutorCard]].forEach(([section,mount,card])=>{
      const items=visible(all(section));
      if(!items.length){message(mount,l().empty);return}
      mount.innerHTML=items.map((item,index)=>card(item,index,items)).join("");
    });
    adminBar.hidden=!state.admin;
    if(state.admin)adminBar.innerHTML=`<div><strong>${l().manager}</strong><span>${l().hint}</span></div><div class="team-admin-actions">
      ${state.editMode?`<button class="team-admin-button accent" data-team-add>${l().add}</button>`:""}
      <button class="team-admin-button primary" data-team-toggle>${state.editMode?l().done:l().editMode}</button></div>`;
  }
  function emptyLocalized(){return{en:"",zhHant:"",zhHans:""}}
  function newDraft(){
    const draft={personId:"",name:"",initials:"",section:"tutor",status:"draft",sortOrder:0,school:"",grade:"",showSchool:false,showGrade:false,consentConfirmed:false};
    textFields.forEach(field=>draft[field]=emptyLocalized());return draft
  }
  function openEditor(item){
    state.draft=item?JSON.parse(JSON.stringify({...item,consentConfirmed:Boolean(item.publicationConsentAt)})):newDraft();
    state.activeLocale=locale();buildEditor();dialog.showModal()
  }
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
    dialog.innerHTML=`<div class="team-editor-shell"><header class="team-editor-head"><div><h3>${state.draft.id?l().editTitle:l().newTitle}</h3><small>${l().shared}</small></div><button class="team-admin-button" data-close>×</button></header>
    <form data-team-form><div class="team-editor-body"><div class="team-basic-grid">
      ${state.draft.id?"":`<div class="team-field wide"><label>${l().existing}</label><select name="personId"><option value="">${l().newPerson}</option>${peopleOptions}</select></div>`}
      ${field("name",l().name)}${field("initials",l().initials)}
      <div class="team-field"><label>${l().section}</label><select name="section"><option value="leader" ${state.draft.section==="leader"?"selected":""}>${l().leader}</option><option value="tutor" ${state.draft.section==="tutor"?"selected":""}>${l().tutor}</option></select></div>
      ${field("school",l().school)}${field("grade",l().grade)}
      <label class="team-check"><input type="checkbox" name="showSchool" ${state.draft.showSchool?"checked":""}>${l().showSchool}</label>
      <label class="team-check"><input type="checkbox" name="showGrade" ${state.draft.showGrade?"checked":""}>${l().showGrade}</label>
      <label class="team-check team-field wide"><input type="checkbox" name="consentConfirmed" ${state.draft.consentConfirmed?"checked":""}>${l().consent}</label>
    </div>
    <div class="team-locale-tabs" role="tablist">${locales.map(key=>`<button type="button" class="team-locale-tab" role="tab" data-locale="${key}" data-complete="${complete(key)}" aria-selected="${state.activeLocale===key}"><span class="team-locale-dot"></span>${labelsForLocale[key]}</button>`).join("")}</div>
    <div class="team-locale-panel">${localField("role",l().role)}${localField("schoolDisplay",l().schoolDisplay)}${localField("languages",l().languages)}${localField("strengths",l().strengths,true)}${localField("summary",l().summary,true)}${localField("bio",l().bio,true)}${localField("hobbies",l().hobbies,true)}${state.activeLocale!=="en"?`<button type="button" class="team-admin-button" data-copy-en>${l().copy}</button>`:""}</div>
    <p class="team-form-error" data-form-error hidden></p></div>
    <footer class="team-editor-footer"><div>${state.draft.id?`<button type="button" class="team-admin-button danger" data-delete>${l().delete}</button>`:""}</div><div class="team-editor-actions"><button type="button" class="team-admin-button" data-cancel>${l().cancel}</button><button type="button" class="team-admin-button primary" data-save="draft">${l().saveDraft}</button><button type="button" class="team-admin-button accent" data-save="published">${l().publish}</button></div></footer></form></div>`;
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
  async function save(status){
    if(state.busy)return;state.busy=true;const body=payload(status);
    try{
      const response=await fetch(state.draft.id?`/api/team-profiles/${encodeURIComponent(state.draft.id)}`:"/api/team-profiles",{method:state.draft.id?"PATCH":"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const data=await response.json().catch(()=>null);if(!response.ok)throw errorFrom(response,data);
      dialog.close();await load(true);showToast(l().saved,false)
    }catch(error){const box=dialog.querySelector("[data-form-error]");box.hidden=false;box.textContent=error.status===409?l().conflict:(error.issues?Object.values(error.issues).join(" · "):error.message);state.busy=false}
  }
  async function remove(){
    if(!state.draft.id||!confirm(l().deleteConfirm))return;
    const response=await fetch(`/api/team-profiles/${encodeURIComponent(state.draft.id)}`,{method:"DELETE",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({profileVersion:state.draft.profileVersion,personVersion:state.draft.personVersion})});
    const data=await response.json().catch(()=>null);if(!response.ok){showToast(response.status===409?l().conflict:data&&data.error||l().validation,true);return}
    dialog.close();await load(true);showToast(l().deleted,false)
  }
  async function move(id,direction){
    const item=[...state.leaders,...state.tutors].find(profile=>profile.id===id);const items=all(item.section);const index=items.findIndex(profile=>profile.id===id),target=index+direction;if(target<0||target>=items.length)return;
    [items[index],items[target]]=[items[target],items[index]];
    const response=await fetch("/api/team-profiles/reorder",{method:"PATCH",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({section:item.section,ordered:items.map(profile=>({id:profile.id,version:profile.profileVersion}))})});
    if(!response.ok){showToast(l().conflict,true)}await load(true)
  }
  async function load(admin){
    try{
      const response=await fetch(`/api/team-profiles${admin?"?includeDrafts=true":""}`,{credentials:"same-origin",cache:"no-store"});
      if(!response.ok)throw new Error("load");const data=await response.json();
      state.leaders=Array.isArray(data.leaders)?data.leaders:[];state.tutors=Array.isArray(data.tutors)?data.tutors:[];state.people=Array.isArray(data.people)?data.people:[];state.admin=Boolean(data.admin)||state.admin;state.busy=false;render()
    }catch(error){if(!state.leaders.length&&!state.tutors.length){message(leaderMount,l().failed);message(tutorMount,l().failed)}}
  }
  document.addEventListener("click",event=>{
    const button=event.target.closest("button");if(!button)return;
    if(button.matches("[data-team-toggle]")){state.editMode=!state.editMode;render()}
    else if(button.matches("[data-team-add]"))openEditor(null);
    else if(button.dataset.edit)openEditor([...state.leaders,...state.tutors].find(item=>item.id===button.dataset.edit));
    else if(button.dataset.move)move(button.dataset.move,Number(button.dataset.direction));
    else if(button.matches("[data-close],[data-cancel]"))dialog.close();
    else if(button.dataset.save)save(button.dataset.save);
    else if(button.matches("[data-delete]"))remove();
    else if(button.dataset.locale){syncDraft();state.activeLocale=button.dataset.locale;buildEditor()}
    else if(button.matches("[data-copy-en]")){syncDraft();textFields.forEach(field=>state.draft[field][state.activeLocale]=state.draft[field].en);buildEditor()}
  });
  dialog.addEventListener("input",event=>{if(event.target.name)syncDraft()});
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
  window.addEventListener("ihear:language",()=>{render();if(dialog.open){syncDraft();buildEditor()}});
  window.addEventListener("ihear:auth",event=>{const session=event.detail&&event.detail.session;if(session&&session.user&&session.user.isAdmin){state.admin=true;load(true)}else{state.admin=false;state.editMode=false;load(false)}});
  message(leaderMount,l().loading);message(tutorMount,l().loading);load(false);
})();
