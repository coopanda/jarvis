/* Cookie-session capability controls. Styling lives in style.css; no credentials handled here. */
(() => {
  'use strict';
  let state=null,busy=false,rows,status;
  const tracks=new Set(),recognizers=new Set();
  const allowed=key=>state?.toggles?.[key]===true;
  const denied=key=>new DOMException('Permission OFF: '+key,'NotAllowedError');
  function stopLocal(){for(const t of tracks)t.stop();tracks.clear();for(const r of recognizers)r.abort();recognizers.clear();window.speechSynthesis?.cancel();}
  async function request(body){const r=await fetch('/api/permissions',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok)throw new Error(r.status===401?'Owner session required. Permissions remain OFF until owner access is authorized.':data.error||'Permission settings unavailable.');return data;}
  async function refresh(){const old=state;try{state=await request({operation:'read'});}catch(e){state=null;stopLocal();if(status)status.textContent=e.message;render();throw e;}if(old&&Object.keys(old.toggles).some(k=>old.toggles[k]&&!state.toggles[k]))stopLocal();render();return state;}
  async function change(toggles){if(busy||!state)return;busy=true;render();if(Object.values(toggles).some(v=>!v))stopLocal();try{state=await request({operation:'update',revision:state.revision,toggles});}catch(e){state=null;stopLocal();status.textContent=e.message+' Reload before trying again.';}finally{busy=false;render();}}
  function render(){if(!rows)return;rows.replaceChildren();if(!state)return;status.textContent=[state.connectionWarning,state.warning].filter(Boolean).join(' ');for(const [key,label]of Object.entries(state.labels)){const line=document.createElement('div');line.className='jarvis-permission-row';const text=document.createElement('span');text.textContent=label;const b=document.createElement('button');b.type='button';b.setAttribute('role','switch');b.setAttribute('aria-checked',String(allowed(key)));b.setAttribute('aria-label',label);b.textContent=allowed(key)?'ON':'OFF';b.disabled=busy;b.onclick=()=>change({[key]:!allowed(key)});line.append(text,b);rows.append(line);}}
  const media=navigator.mediaDevices;
  if(media?.getUserMedia){const original=media.getUserMedia.bind(media);media.getUserMedia=async c=>{await refresh();if(c.audio&&!allowed('microphone'))throw denied('microphone');if(c.video&&!allowed('camera'))throw denied('camera');const stream=await original(c);stream.getTracks().forEach(t=>tracks.add(t));return stream;};}
  if(media?.getDisplayMedia){const original=media.getDisplayMedia.bind(media);media.getDisplayMedia=async c=>{await refresh();if(!allowed('screen'))throw denied('screen');const stream=await original(c);stream.getTracks().forEach(t=>tracks.add(t));return stream;};}
  for(const C of new Set([window.SpeechRecognition,window.webkitSpeechRecognition].filter(Boolean))){const original=C.prototype.start;C.prototype.start=function(...args){if(!allowed('microphone'))throw denied('microphone');recognizers.add(this);return original.apply(this,args);};}
  if(window.speechSynthesis){const original=speechSynthesis.speak.bind(speechSynthesis);speechSynthesis.speak=u=>{if(!allowed('voice'))throw denied('voice');return original(u);};}
  window.JarvisPermissions=Object.freeze({allowed,refresh,stopLocal});window.addEventListener('pagehide',stopLocal);
  document.addEventListener('DOMContentLoaded',()=>{
    const panel=document.createElement('details');panel.id='jarvis-permissions';
    const title=document.createElement('summary');title.textContent='Permissions & Connections';
    const content=document.createElement('section');content.setAttribute('aria-label','Permissions and connection settings');
    status=document.createElement('p');status.setAttribute('role','status');status.textContent='All OFF until authorized settings load.';rows=document.createElement('div');
    const reload=document.createElement('button');reload.type='button';reload.textContent='Reload permissions';reload.onclick=()=>refresh().catch(()=>{});
    const revoke=document.createElement('button');revoke.type='button';revoke.textContent='All OFF / Stop';revoke.onclick=()=>{stopLocal();if(state)change(Object.fromEntries(Object.keys(state.labels).map(k=>[k,false])));};
    const actions=document.createElement('div');actions.className='permission-actions';actions.append(reload,revoke);
    const note=document.createElement('p');note.textContent='ON grants capability only, not a connection. Browser device consent, configured accounts and exact external-action approval remain separate. Desktop bridge: architecture specification only; no device paired.';
    content.append(status,rows,actions,note);panel.append(title,content);document.body.append(panel);
    panel.addEventListener('toggle',()=>{if(panel.open)refresh().catch(()=>{});});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&panel.open){panel.open=false;title.focus();}});
    document.addEventListener('click',e=>{if(panel.open&&!panel.contains(e.target))panel.open=false;});
    refresh().catch(()=>{});setInterval(()=>{if(!busy)refresh().catch(()=>{});},15000);
  });
})();
