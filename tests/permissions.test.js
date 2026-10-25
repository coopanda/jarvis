import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createPermissions,PERMISSIONS} from '../permissions.js';
import {createToolRouter,normalizeBrainResponse} from '../tools.js';

function fixture(initial={}) {
  const files=structuredClone(initial);let revoked=[];
  const write=async(path,content,revision)=>{assert.equal(revision,files[path]?.version||0);files[path]={content,version:revision+1};};
  const permissions=createPermissions({files:()=>files,write,onRevoke:async keys=>{revoked.push(...keys);}});
  return {permissions,files,revoked};
}
test('all capabilities default OFF, including unknown destinations',()=>{
  const {permissions:p}=fixture();for(const key of Object.keys(PERMISSIONS)){assert.equal(p.read().toggles[key],false);assert.throws(()=>p.require(key),{status:403});}
  assert.throws(()=>p.require('unknown'),{status:403});assert.throws(()=>p.tool('arbitrary.shell'),{status:403});assert.throws(()=>p.route('/api/unmapped'),{status:403});
});
test('persisted updates, revision conflict, revoke and ephemeral warning',async()=>{
  const f=fixture();const p=f.permissions;assert.equal(p.read().durable,false);assert.match(p.read().warning,/ephemeral/);
  const enabled=await p.update({revision:0,toggles:{ai:true,files:true}});assert.equal(enabled.revision,1);p.require('ai');
  await assert.rejects(p.update({revision:0,toggles:{ai:false}}),{status:409});
  const restored=createPermissions({files:()=>f.files,write:async()=>{}});assert.equal(restored.read().toggles.ai,true);
  await p.update({revision:1,toggles:{ai:false}});assert.deepEqual(f.revoked,['ai']);assert.throws(()=>p.require('ai'),{status:403});
});
test('malformed settings fail closed',()=>{
  for(const content of ['{bad','null','{"schema":2,"toggles":{}}','{"schema":1,"toggles":null}']){
    const {permissions:p}=fixture({'memory/permissions.json':{content,version:1}});assert.throws(()=>p.require('ai'));
  }
});
test('unknown keys and nonboolean updates rejected',async()=>{
  const {permissions:p}=fixture();for(const toggles of [{unknown:true},{ai:'true'}])await assert.rejects(p.update({revision:0,toggles}),{status:400});
});
test('generic workspace cannot modify permission settings',async()=>{
  const {permissions:p}=fixture();await p.update({revision:0,toggles:{files:true}});
  for(const operation of ['write','delete'])assert.throws(()=>p.route('/api/workspace',{operation,path:'memory/permissions.json'}),{status:403});
});
test('route permissions enforced independently',async()=>{
  const {permissions:p}=fixture();for(const path of ['/api/mission','/api/vision','/api/research','/api/email/send','/api/browser/run','/api/media/create','/api/content','/api/companion'])assert.throws(()=>p.route(path),{status:403});
  await p.update({revision:0,toggles:{ai:true}});p.route('/api/mission',{message:'Hello'});assert.throws(()=>p.route('/api/mission',{message:'read calendar'}),{status:403});assert.throws(()=>p.route('/api/vision',{source:'screen'}),{status:403});
  for(const path of ['/api/session','/api/stop','/api/disconnect','/api/permissions'])p.route(path);
});
test('job approvals recover capability from persistent state',async()=>{
  const {permissions:p}=fixture({'memory/integrations.json':{version:1,content:JSON.stringify({jobs:[{id:'job1',tool:'voice.synthesize'}]})}});
  assert.throws(()=>p.route('/api/tools',{operation:'approve',id:'job1'}),{status:403});await p.update({revision:0,toggles:{voice:true}});p.route('/api/tools',{operation:'approve',id:'job1'});
  assert.throws(()=>p.route('/api/tools',{operation:'approve',id:'missing'}),{status:403});
});
test('tool router retains actual session active Map',async()=>{
  const session={active:new Map()};let observed;
  const suite={handle:async(body,s)=>{observed=s;return {ok:true};}};
  const router=createToolRouter({integrations:suite,operations:suite});await router.handle('/api/integrations',{operation:'status'},session);assert.equal(observed,session);assert.ok(observed.active instanceof Map);
});
test('brain response normalization preserves structured reply',()=>{
  assert.equal(normalizeBrainResponse({reply:'ready',tool:null}).reply,'ready');
});
test('server and frontend contain dedicated settings and native capture guards',async()=>{
  const server=await readFile(new URL('../server.js',import.meta.url),'utf8');assert.match(server,/async function writePermissionStorage\(/);assert.match(server,/active:new Map\(\)/);assert.match(server,/permissions\.route\(url\.pathname,body\)/);
  const ui=await readFile(new URL('../public/permissions-ui.js',import.meta.url),'utf8');for(const fragment of ['role','switch','aria-checked','getUserMedia','getDisplayMedia','speechSynthesis','revision:state.revision'])assert.ok(ui.includes(fragment),fragment);
});
test('startup health build, script delivery and unauthenticated action denial',{timeout:25000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jarvis-ci-'));const port=19387;const env={PATH:process.env.PATH,HOME:dir,PORT:String(port),WORKSPACE_DIR:dir,JARVIS_WORKSPACE_DIR:dir,RENDER_GIT_COMMIT:'ci-permissions-build'};
  const child=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env,stdio:'ignore'});
  try{let response;for(let n=0;n<60;n++){try{response=await fetch(`http://127.0.0.1:${port}/health`);if(response.ok)break;}catch{}if(child.exitCode!==null)throw new Error('Server exited before healthy startup');await new Promise(r=>setTimeout(r,150));}
    assert.ok(response?.ok,'healthy startup');const health=await response.json();assert.equal(health.version,'mark6-permissions');assert.equal(health.build,'ci-permissions-build');assert.equal(health.ok,true);
    const ui=await fetch(`http://127.0.0.1:${port}/permissions-ui.js`);assert.equal(ui.status,200);assert.match(await ui.text(),/JarvisPermissions/);
    const page=await fetch(`http://127.0.0.1:${port}/`);assert.match(await page.text(),/permissions-ui\.js/);
    const action=await fetch(`http://127.0.0.1:${port}/api/permissions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'read'})});assert.ok([401,403,503].includes(action.status));
  }finally{child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)resolve();else{child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},5500).unref();}});await rm(dir,{recursive:true,force:true});}
});
