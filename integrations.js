import { createHash, randomUUID } from 'node:crypto';

// Reviewed first-party equivalents, not installations of similarly named third-party plugins.
export const INSTAGRAM_TOOLS = Object.freeze(['brief','hooks','script','caption','hashtags','carousel','calendar','repurpose','analytics','reply','publish']);
export const MARKETING_SKILLS = Object.freeze(['copywriting','seo-audit','keyword-research','search-intent','content-brief','blog-outline','blog-draft','meta-title','meta-description','schema-plan','internal-linking','content-refresh','landing-page','homepage','product-page','pricing-page','about-page','faq','cta','headline','value-proposition','positioning','personas','competitive-analysis','brand-voice','sales-email','email-sequence','newsletter','subject-lines','lead-magnet','ad-copy','social-post','campaign-plan','funnel-plan','conversion-review','ab-test-plan','case-study','press-release','launch-plan','retention-plan','referral-plan','marketing-measurement']);
const STATE='memory/integrations.json';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=12000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw fail(`Text must contain 1-${max} characters.`);return v.trim();};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function packContext(input,query='',maxChars=16000){
  if(typeof input!=='string')throw fail('Context must be text.');
  const budget=Math.max(1000,Math.min(40000,Number(maxChars)||16000));
  const words=new Set(String(query).toLowerCase().match(/[a-z0-9]{3,}/g)||[]);
  const chunks=input.split(/\n\s*\n/).map((content,index)=>({content,index,score:[...words].filter(w=>content.toLowerCase().includes(w)).length}));
  let used=0;const selected=[];
  for(const chunk of [...chunks].sort((a,b)=>b.score-a.score||a.index-b.index)){const remaining=budget-used-2;if(remaining<=0)break;const content=chunk.content.slice(0,remaining);selected.push({...chunk,content});used+=content.length+2;}
  const output=selected.sort((a,b)=>a.index-b.index).map(c=>c.content).join('\n\n');
  return {text:output,originalChars:input.length,retainedChars:output.length,truncated:output.length<input.length,sourceHash:hash(input),method:'query-ranked extractive selection; omitted context is not summarized',estimatedTokens:Math.ceil(Buffer.byteLength(output,'utf8')/3),tokenEstimateOnly:true};
}

export function createIntegrationSuite({env,brain,files,write,audit,validateURL,isDurable,fetchImpl=fetch}){
  let tail=Promise.resolve(),timer,halted=false;const active=new Map();
  const configured=(...keys)=>keys.every(k=>Boolean(env[k]));
  const models={claude:'ANTHROPIC_API_KEY',opus:'ANTHROPIC_API_KEY',openai:'OPENAI_API_KEY',openrouter:'OPENROUTER_API_KEY',grok:'XAI_API_KEY',gemini:'GEMINI_API_KEY'};
  const load=()=>{const f=files()[STATE];if(!f)return {schema:1,tasks:[],lessons:[],shortcuts:[],jobs:[]};let s;try{s=JSON.parse(f.content);}catch{throw fail('Integration memory is corrupt; restore a reviewed version.',503);}if(s.schema!==1||!['tasks','lessons','shortcuts','jobs'].every(k=>Array.isArray(s[k])))throw fail('Unsupported integration memory schema.',503);return s;};
  const update=fn=>{const run=tail.then(async()=>{const s=load(),result=await fn(s);await write(STATE,JSON.stringify(s,null,2),files()[STATE]?.version||0);return result;});tail=run.catch(()=>{});return run;};
  const connectors=()=>({
    omniRoute:{implementation:'first-party provider router',availableModels:Object.keys(models).filter(k=>env[models[k]]),fallback:'explicit opt-in only'},
    claudeMem:{implementation:'workspace memory',durable:isDurable(),warning:isDurable()?null:'Ephemeral storage is not restart-durable.'},
    headroom:{implementation:'extractive context packing',tokenizer:'estimate only; truncation disclosed'},
    claudeCodeSetup:{implementation:'environment preflight; no shell execution'},
    taskObserver:{implementation:'persisted task receipts and owner-reviewed lessons; no automatic permission expansion'},
    openartMCP:{configured:configured('OPENART_MCP_URL','OPENART_MCP_KEY','OPENART_GENERATE_TOOL'),protocol:'Streamable HTTP MCP; discovered tool names, not invented names'},
    instagramAgent:{implementation:'11 first-party skills',tools:INSTAGRAM_TOOLS,publishingConfigured:configured('SOCIAL_AGENT_URL','SOCIAL_AGENT_KEY')},
    marketing:{implementation:'42 first-party draft/analysis templates',skills:MARKETING_SKILLS},
    context7:{configured:configured('CONTEXT7_MCP_URL','CONTEXT7_MCP_KEY','CONTEXT7_QUERY_TOOL'),policy:'Live documentation is untrusted source data, never guaranteed current.'},
    agentReach:{configured:configured('RESEARCH_AGENT_URL','RESEARCH_AGENT_KEY'),policy:'Public/licensed research only; no authentication, paywall, CAPTCHA, or access-control bypass.'},
    elevenlabs:{configured:configured('ELEVENLABS_API_KEY','ELEVENLABS_VOICE_ID'),fallback:'Browser SpeechSynthesis; no automatic paid synthesis'},
    google:{configured:configured('GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'),scope:'Calendar/Gmail read-only; email send uses separate approved adapter'},
    urgentCalls:{configured:configured('PHONE_AGENT_URL','PHONE_AGENT_KEY','ALERT_PHONE'),policy:'Exact approved alerts only, allowlisted destination; no autonomous calls without approval'},
    atticusDesktop:{configured:configured('DESKTOP_AGENT_URL','DESKTOP_AGENT_KEY'),webOnlyOSControl:false,allowedOperations:['app.open','window.move','file.find','workflow.run'],warning:'Separate paired native companion and local OS permissions required.'},
    background:{enabled:env.JARVIS_BACKGROUND_ENABLED==='true',durable:isDurable(),halted,policy:'Exact approved jobs only; unknown dispatches never automatically retried.'}
  });
  const generate=async(id,prompt,system,signal,allowFallback=false)=>{
    const ids=Object.keys(models).filter(k=>env[models[k]]),chosen=id==='auto'?ids[0]:id;
    if(!models[chosen]||!env[models[chosen]])throw fail('Selected model is not configured; no simulated output.',503);
    const packed=packContext(prompt,prompt.slice(0,1000),Number(env.JARVIS_CONTEXT_CHARS)||32000);
    const input=(packed.truncated?'[Context was extractively truncated; do not assume omitted facts.]\n':'')+packed.text;
    try{return {...await brain(chosen,input,system,signal),routing:{requested:id,used:chosen,fallback:false},context:packed};}
    catch(e){if(!allowFallback||signal?.aborted||(e.status&&e.status<500))throw e;const next=ids.find(k=>k!==chosen&&models[k]!==models[chosen]);if(!next)throw e;return {...await brain(next,input,system,signal),routing:{requested:id,used:next,fallback:true},context:packed};}
  };
  const observe=async(label,fn)=>{const id=randomUUID();await update(s=>{s.tasks.push({id,label:text(label,240),state:'running',startedAt:new Date().toISOString()});s.tasks=s.tasks.slice(-100);});try{const result=await fn();await update(s=>{const t=s.tasks.find(t=>t.id===id);if(t){t.state='completed';t.finishedAt=new Date().toISOString();}});return result;}catch(e){await update(s=>{const t=s.tasks.find(t=>t.id===id);if(t){t.state='failed';t.finishedAt=new Date().toISOString();}}).catch(()=>{});throw e;}};
  const bounded=async(response,max=2000000)=>{let size=0,parts=[];for await(const part of response.body||[]){size+=part.length;if(size>max)throw fail('Connector response exceeds limit.',502);parts.push(Buffer.from(part));}return Buffer.concat(parts);};
  const request=async(url,key,payload,signal,extraHeaders={})=>{
    await validateURL(url);if(!url.startsWith('https://'))throw fail('Connectors require public HTTPS endpoints.');
    const response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${key}`,...extraHeaders},body:JSON.stringify(payload),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
    if(!response.ok)throw fail(`Connector HTTP ${response.status}; outcome may be unknown.`,502);
    if(response.status===202||response.status===204)return {data:null,session:response.headers.get('mcp-session-id')};
    const raw=(await bounded(response)).toString('utf8');if(!raw&&payload.id===undefined)return {data:null,session:response.headers.get('mcp-session-id')};let data;
    try{data=JSON.parse(raw);}catch{const events=raw.split(/\r?\n\r?\n/).map(e=>e.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n')).filter(Boolean);for(const event of events){try{const candidate=JSON.parse(event);if(candidate.id===payload.id)data=candidate;}catch{}}}
    if(!data)throw fail('Connector returned an unsupported response.',502);return {data,session:response.headers.get('mcp-session-id')};
  };
  const mcp=async(prefix,name,args,signal,inspect=false)=>{
    if(!configured(prefix+'_MCP_URL',prefix+'_MCP_KEY'))throw fail(prefix+' MCP endpoint/credentials not configured.',503);
    const endpoint=env[prefix+'_MCP_URL'],key=env[prefix+'_MCP_KEY'];
    const init=await request(endpoint,key,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'jarvis',version:'1.0.0'}}},signal);
    const version=init.data?.result?.protocolVersion;if(init.data?.error||!['2025-03-26','2025-06-18','2024-11-05'].includes(version))throw fail('MCP initialization/protocol not supported.',502);
    const headers={'MCP-Protocol-Version':version,...(init.session?{'Mcp-Session-Id':init.session}:{})};
    await request(endpoint,key,{jsonrpc:'2.0',method:'notifications/initialized'},signal,headers);
    const list=await request(endpoint,key,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},signal,headers),tools=list.data?.result?.tools;
    if(!Array.isArray(tools))throw fail('MCP returned no tool manifest.',502);
    if(inspect)return {tools:tools.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})),protocol:version};
    if(!tools.some(t=>t.name===name))throw fail('Configured tool absent from discovered MCP manifest.',503);
    const result=await request(endpoint,key,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name,arguments:args}},signal,headers);
    if(result.data?.error||result.data?.result?.isError||!result.data?.result)throw fail('MCP tool failed or returned no receipt; inspect status before retrying.',502);
    return {provider:prefix.toLowerCase()+'-mcp',receipt:result.data.result,observedAt:new Date().toISOString(),completion:'Provider receipt only; inspect generation completion or source freshness separately.'};
  };
  const execute=async(job,signal)=>{
    const p=job.payload;
    if(job.tool==='openart.generate')return mcp('OPENART',env.OPENART_GENERATE_TOOL,p,signal);
    if(job.tool==='voice.synthesize'){
      if(!configured('ELEVENLABS_API_KEY','ELEVENLABS_VOICE_ID'))throw fail('ElevenLabs is not configured.',503);
      const voice=env.ELEVENLABS_VOICE_ID;if(!/^[A-Za-z0-9_-]{1,80}$/.test(voice))throw fail('Invalid configured voice ID.',503);
      const response=await fetchImpl('https://api.elevenlabs.io/v1/text-to-speech/'+voice,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','xi-api-key':env.ELEVENLABS_API_KEY,Accept:'audio/mpeg'},body:JSON.stringify({text:p.text,model_id:env.ELEVENLABS_MODEL||'eleven_multilingual_v2'}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
      if(!response.ok)throw fail('ElevenLabs synthesis failed; inspect usage before retrying.',502);
      if(!(response.headers.get('content-type')||'').includes('audio/'))throw fail('Voice provider returned no audio.',502);
      return {provider:'elevenlabs',mime:'audio/mpeg',audioBase64:(await bounded(response,1000000)).toString('base64')};
    }
    const map={'instagram.publish':['SOCIAL','publish'],'desktop.run':['DESKTOP',p.action],'phone.alert':['PHONE','call']};const entry=map[job.tool];if(!entry)throw fail('Tool not executable.');const [prefix,action]=entry;
    if(!configured(prefix+'_AGENT_URL',prefix+'_AGENT_KEY'))throw fail(prefix+' adapter not configured.',503);
    const payload=job.tool==='phone.alert'?{to:env.ALERT_PHONE,message:p.message,priority:'urgent'}:job.tool==='desktop.run'?{args:p.args}:p;
    const result=await request(env[prefix+'_AGENT_URL'],env[prefix+'_AGENT_KEY'],{...payload,action,approved:true,idempotencyKey:job.id,approval:{id:job.id,digest:job.digest,expiresAt:new Date(Date.now()+60000).toISOString()}},signal);
    if(!result.data?.id&&!result.data?.receipt&&!result.data?.url)throw fail('Adapter returned no receipt; outcome unknown.',502);
    return {provider:prefix.toLowerCase()+'-adapter',receipt:result.data,completion:'Receipt only; verify provider completion state.'};
  };
  const dispatch=async(id,signal)=>{
    if(halted)throw fail('Emergency stop is active; explicitly resume before dispatch.',409);
    const job=await update(s=>{const j=s.jobs.find(j=>j.id===id);if(!j||j.state!=='queued')throw fail('Job not queued; never retry uncertain dispatch.',409);j.state='dispatching';j.dispatchedAt=new Date().toISOString();return structuredClone(j);});
    const controller=new AbortController();active.set(id,controller);const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    try{const result=await execute(job,combined);await update(s=>{const j=s.jobs.find(j=>j.id===id);j.state='receipt';j.result=result.audioBase64?{provider:result.provider,mime:result.mime,audioBytes:Buffer.byteLength(result.audioBase64,'base64')}:result;j.finishedAt=new Date().toISOString();});await audit('connector',job.tool+' '+job.id,'provider_receipt');return {id,result};}
    catch(e){await update(s=>{const j=s.jobs.find(j=>j.id===id);j.state='unknown';j.error='May have reached provider; inspect provider before retrying.';}).catch(()=>{});throw e;}finally{active.delete(id);}
  };
  const handle=async(body,session)=>{
    if(!object(body))throw fail('Request must be an object.');const op=body.operation;
    if(op==='status')return {connectors:connectors(),state:load()};
    if(op==='setup')return {connectors:connectors(),environment:{models:Object.values(models),memory:['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN'],openart:['OPENART_MCP_URL','OPENART_MCP_KEY','OPENART_GENERATE_TOOL','OPENART_STATUS_TOOL'],docs:['CONTEXT7_MCP_URL','CONTEXT7_MCP_KEY','CONTEXT7_QUERY_TOOL'],voice:['ELEVENLABS_API_KEY','ELEVENLABS_VOICE_ID'],calls:['PHONE_AGENT_URL','PHONE_AGENT_KEY','ALERT_PHONE'],desktop:['DESKTOP_AGENT_URL','DESKTOP_AGENT_KEY'],research:['RESEARCH_AGENT_URL','RESEARCH_AGENT_KEY'],social:['SOCIAL_AGENT_URL','SOCIAL_AGENT_KEY'],background:['JARVIS_BACKGROUND_ENABLED']},warning:'Set secrets only in Render. No plugin installs or shell execution.'};
    if(op==='resume'){halted=false;start();return {resumed:true};}
    if(op==='context')return packContext(text(body.context,200000),String(body.query||''),body.maxChars);
    if(op==='memory.read')return {files:Object.entries(files()).filter(([p])=>p.startsWith('memory/')).map(([path,f])=>({path,version:f.version,content:f.content}))};
    if(op==='memory.remember'){const content=text(body.content);if(/(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{15,}|-----BEGIN .*PRIVATE KEY/.test(content))throw fail('Do not store credentials in memory.');return write('memory/owner-notes.md',content,body.version,body.append!==false);}
    if(op==='task.lesson'){if(body.approved!==true)throw fail('Owner review required.',403);return update(s=>{const lesson={id:randomUUID(),text:text(body.content,2000),sourceTask:body.taskId||null,approvedAt:new Date().toISOString()};s.lessons.push(lesson);s.lessons=s.lessons.slice(-50);return lesson;});}
    if(op==='shortcut.save'){if(body.approved!==true)throw fail('Review shortcut before saving.',403);const phrase=text(body.phrase,120);if(!Array.isArray(body.steps)||body.steps.length<1||body.steps.length>10)throw fail('Shortcut needs 1-10 steps.');for(const step of body.steps)if(!object(step)||!['app.open','window.move','file.find','workflow.run'].includes(step.action)||!object(step.args))throw fail('Unsupported shortcut action.');return update(s=>{const item={id:randomUUID(),phrase,steps:body.steps,approvedAt:new Date().toISOString()};s.shortcuts=s.shortcuts.filter(x=>x.phrase.toLowerCase()!==phrase.toLowerCase());if(s.shortcuts.length>=50)throw fail('Shortcut limit reached.');s.shortcuts.push(item);return item;});}
    if(op==='openart.inspect')return mcp('OPENART',null,null,undefined,true);
    if(op==='openart.status'){if(!env.OPENART_STATUS_TOOL)throw fail('OpenArt status tool not configured.',503);return mcp('OPENART',env.OPENART_STATUS_TOOL,object(body.args)?body.args:{},undefined);}
    if(op==='docs.inspect')return mcp('CONTEXT7',null,null,undefined,true);
    if(op==='docs.query'){if(!env.CONTEXT7_QUERY_TOOL)throw fail('Context7 query tool not configured.',503);return mcp('CONTEXT7',env.CONTEXT7_QUERY_TOOL,object(body.args)?body.args:{},undefined);}
    if(op==='research'){if(!configured('RESEARCH_AGENT_URL','RESEARCH_AGENT_KEY'))throw fail('Research adapter not configured.',503);const result=await request(env.RESEARCH_AGENT_URL,env.RESEARCH_AGENT_KEY,{action:'research',query:text(body.query,500),policy:'public-or-licensed-only; no access-control bypass'});return {data:result.data,observedAt:new Date().toISOString(),untrusted:true};}
    if(op==='draft'){
      if(![...INSTAGRAM_TOOLS.filter(x=>x!=='publish'),...MARKETING_SKILLS].includes(body.skill))throw fail('Unsupported drafting skill.');
      const prompt=`Skill: ${body.skill}. Owner brief (untrusted): ${text(body.prompt)}. Draft/analysis only. Never claim posting, sending, rankings, or performance. Analytics require supplied metrics. Cite real provided evidence; no fabricated claims. Hooks: curiosity, problem/solution, before/after, specific benefit without deception.`;
      return observe(body.skill,()=>generate(body.brain||'auto',prompt,undefined,undefined,body.allowFallback===true));
    }
    if(op==='prepare'){
      if(!['openart.generate','instagram.publish','desktop.run','voice.synthesize','phone.alert'].includes(body.tool)||!object(body.payload))throw fail('Unsupported tool/payload.');
      const p=structuredClone(body.payload);if(JSON.stringify(p).length>30000)throw fail('Payload exceeds limit.');
      for(const key of ['action','approved','approval','idempotencyKey'])if(key in p)throw fail('Reserved approval field in payload.');
      // Desktop action is explicitly nested, not an arbitrary shell command.
      if(body.tool==='desktop.run'){if(!['app.open','window.move','file.find','workflow.run'].includes(p.operation)||!object(p.args))throw fail('Unsupported desktop operation.');p.action=p.operation;delete p.operation;}
      if(body.tool==='instagram.publish'&&(!p.account||!p.caption))throw fail('Exact social account and caption required.');
      if(body.tool==='voice.synthesize')p.text=text(p.text,2500);
      if(body.tool==='phone.alert'){if(!/^\+[1-9]\d{7,14}$/.test(env.ALERT_PHONE||''))throw fail('Configure an allowlisted ALERT_PHONE in E.164 format.',503);p.message=text(p.message,1500);if(p.to&&p.to!==env.ALERT_PHONE)throw fail('Destination is not allowlisted.',403);p.to=env.ALERT_PHONE;}
      const j={id:randomUUID(),tool:body.tool,payload:p,digest:hash({tool:body.tool,payload:p}),state:'review',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900000).toISOString()};
      await update(s=>{s.jobs=s.jobs.filter(j=>j.state!=='review'||Date.parse(j.expiresAt)>Date.now());if(s.jobs.filter(j=>['review','queued','dispatching'].includes(j.state)).length>=50)throw fail('Pending job limit reached.');s.jobs.push(j);s.jobs=s.jobs.slice(-150);});
      return {...j,warning:'Review exact payload, destination/account, and provider pricing. Approval can cause a paid generation or external change.'};
    }
    if(op==='approve'){
      if(body.approved!==true)throw fail('Explicit owner approval required.',403);const runAt=body.runAt?Date.parse(body.runAt):Date.now();if(!Number.isFinite(runAt)||runAt<Date.now()-60000||runAt>Date.now()+30*86400000)throw fail('Schedule must be now or within 30 days.');
      if(body.runAt&&(!isDurable()||env.JARVIS_BACKGROUND_ENABLED!=='true'))throw fail('Scheduling requires durable storage and enabled background processing.',503);
      const job=await update(s=>{const j=s.jobs.find(j=>j.id===body.id);if(!j||j.state!=='review'||j.digest!==body.digest||Date.parse(j.expiresAt)<Date.now())throw fail('Stale/mismatched approval; prepare again.',409);if(j.tool==='phone.alert'&&j.payload.to!==env.ALERT_PHONE)throw fail('Alert destination changed; prepare again.',409);j.state='queued';j.runAt=new Date(runAt).toISOString();j.approvedAt=new Date().toISOString();return structuredClone(j);});
      if(body.runAt)return {queued:job.id,runAt:job.runAt};const controller=new AbortController();session.active.set(job.id,controller);try{return await dispatch(job.id,controller.signal);}finally{session.active.delete(job.id);}
    }
    if(op==='cancel')return update(s=>{const j=s.jobs.find(j=>j.id===body.id);if(!j||!['review','queued'].includes(j.state))throw fail('Cannot cancel already dispatched job.',409);j.state='cancelled';return {cancelled:j.id};});
    throw fail('Unknown integration operation.');
  };
  const start=()=>{if(timer||halted||env.JARVIS_BACKGROUND_ENABLED!=='true')return;timer=setInterval(async()=>{try{if(!isDurable()||halted)return;for(const j of load().jobs.filter(j=>j.state==='queued'&&Date.parse(j.runAt)<=Date.now()))await dispatch(j.id).catch(()=>{});}catch(e){console.error('Integration tick failed:',e.status||'internal');}},30000);timer.unref();};
  const stop=async()=>{halted=true;if(timer){clearInterval(timer);timer=null;}for(const c of active.values())c.abort();await update(s=>{for(const j of s.jobs)if(j.state==='queued')j.state='cancelled';});return {backgroundStopped:true,warning:'Already dispatched external actions cannot be undone.'};};
  return {connectors,generate,observe,handle,start,stop};
}
