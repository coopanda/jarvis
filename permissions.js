/* Fail-closed permissions. ON grants capability, never supplies credentials or approval. */
export const PERMISSIONS = Object.freeze({
  ai:'AI / model connections', microphone:'Microphone / hands-free voice', voice:'Spoken replies / TTS',
  camera:'Camera observation', screen:'Screen observation', files:'Workspace / local files', photos:'Local photos',
  companion:'Local desktop companion', calendar:'Google Calendar (read only)', gmail:'Gmail / email',
  calls:'Phone calls / reservations', web:'Live web search / fetch', browser:'Website sign-in / browser actions',
  social:'Social account publishing', media:'Image / video providers', trading:'Market research / paper trading',
  background:'Scheduled background work'
});
const PATH='memory/permissions.json';
const problem=(message,status=403)=>Object.assign(new Error(message),{status});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export function createPermissions({files,write,isDurable=()=>false,onRevoke=async()=>{}}){
  let serial=Promise.resolve();
  function read(){
    const f=files()[PATH];let s;
    if(f){try{s=JSON.parse(f.content);}catch{throw problem('Permission settings corrupt; all capabilities disabled.',503);}
      if(s.schema!==1||!object(s.toggles))throw problem('Unsupported permission settings; all capabilities disabled.',503);}
    const toggles=Object.fromEntries(Object.keys(PERMISSIONS).map(k=>[k,s?.toggles[k]===true]));
    return {schema:1,revision:f?.version||0,updatedAt:s?.updatedAt||null,toggles,labels:PERMISSIONS,durable:isDurable(),warning:isDurable()?null:'Settings use ephemeral storage: OFF after a fresh Render filesystem. Provision Redis or a persistent disk for restart durability.',connectionWarning:'ON is permission only, not a connected account. External actions still require exact approval.'};
  }
  function requirePermission(key){if(!(key in PERMISSIONS)||read().toggles[key]!==true)throw problem('Permission OFF: '+key);}
  function tool(name){
    if(typeof name!=='string')throw problem('Unknown tool permission.');
    if(/^(workspace\.|memory\.|file\.)/.test(name))requirePermission('files');
    else if(/^(research|fetch|docs\.)/.test(name))requirePermission('web');
    else if(/^(phone\.)/.test(name))requirePermission('calls');
    else if(/^(instagram\.publish|social\.|meta\.change)/.test(name))requirePermission('social');
    else if(/^(hermes\.|browser\.)/.test(name))requirePermission('browser');
    else if(/^(desktop\.|companion\.)/.test(name))requirePermission('companion');
    else if(/^(media\.|openart\.)/.test(name))requirePermission('media');
    else if(name==='voice.synthesize')requirePermission('voice');
    else if(/^(market\.|trade\.)/.test(name))requirePermission('trading');
    else throw problem('No permission mapping for tool: '+name);
  }
  function job(body){
    if(body.tool)return tool(body.tool);
    for(const path of ['memory/integrations.json','memory/agent-operations.json']){
      let state;try{state=JSON.parse(files()[path]?.content||'{}');}catch{throw problem('Job state corrupt.',503);}
      const j=state.jobs?.find(x=>x.id===body.id);if(j)return tool(j.tool);
    }
    throw problem('Unknown approval job; permission cannot be established.');
  }
  function route(path,body={}){
    if(['/api/permissions','/api/session','/api/stop','/api/disconnect'].includes(path))return;
    if(['/api/integrations','/api/agents','/api/tools'].includes(path)){
      const op=body.operation;
      if(['registry','status','setup','scan','cancel','daily.disable','resume'].includes(op))return;
      if(op==='prepare'||op==='approve')return job(body);
      if(op==='research'||op?.startsWith('docs.'))return requirePermission('web');
      if(op?.startsWith('openart.'))return requirePermission('media');
      if(op?.startsWith('memory.')||['lesson','task.lesson','shortcut.save'].includes(op))return requirePermission('files');
      if(op==='business.inspect'||op==='business.read')return requirePermission('social');
      if(op==='context'||op==='draft'||op==='run'){requirePermission('ai');if(op==='run')requirePermission('files');return;}
      if(op==='daily.configure'){requirePermission('background');requirePermission('ai');requirePermission('files');if(body.sources?.length)requirePermission('web');return;}
      throw problem('No permission mapping for operation.');
    }
    if(path==='/api/mission'){requirePermission('ai');if(/\b(calendar|schedule)\b/i.test(body.message||''))requirePermission('calendar');if(/\b(email|gmail|inbox)\b/i.test(body.message||''))requirePermission('gmail');return;}
    if(path==='/api/vision'){requirePermission('ai');requirePermission(body.source==='camera'?'camera':'screen');return;}
    if(['/api/research','/api/fetch'].includes(path))return requirePermission('web');
    if(['/api/workspace','/api/memory'].includes(path)){requirePermission('files');if(body.path===PATH&&['write','delete'].includes(body.operation))throw problem('Permission settings must use their dedicated endpoint.');return;}
    if(path==='/api/email/send')return requirePermission('gmail');
    if(path.startsWith('/api/browser/'))return requirePermission('browser');
    if(path.startsWith('/api/media/'))return requirePermission('media');
    if(path.startsWith('/api/content'))return requirePermission('social');
    if(path.startsWith('/api/companion')){requirePermission('companion');return;}
    throw problem('No permission mapping for route.');
  }
  function update(body){
    const run=serial.then(async()=>{
      if(!object(body)||!object(body.toggles)||!Number.isInteger(body.revision))throw problem('Expected toggles and current revision.',400);
      const before=read();if(body.revision!==before.revision)throw problem('Settings changed; reload before saving.',409);
      for(const [key,value]of Object.entries(body.toggles))if(!(key in PERMISSIONS)||typeof value!=='boolean')throw problem('Unknown or non-boolean permission.',400);
      const toggles={...before.toggles,...body.toggles};
      await write(PATH,JSON.stringify({schema:1,toggles,updatedAt:new Date().toISOString()},null,2),before.revision);
      const revoked=Object.keys(toggles).filter(k=>before.toggles[k]&&!toggles[k]);
      if(revoked.length)await onRevoke(revoked);
      return read();
    });serial=run.catch(()=>{});return run;
  }
  return {read,update,require:requirePermission,tool,route};
}
