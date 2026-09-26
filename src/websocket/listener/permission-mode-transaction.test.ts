import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Fresh processes keep module caches alive across the external writer without
// leaking HOME/backend state into other tests. No models, sockets or mock.module.
const sourceRoot = path.resolve(import.meta.dir, "../..");
const worker = `
const fs = await import('node:fs');
const assert = (await import('node:assert/strict')).default;
const {spawnSync,spawn} = await import('node:child_process');
const root = process.env.FIXTURE_SOURCE;
const scenario = process.env.FIXTURE_SCENARIO;
const file = process.env.HOME+'/.letta/remote-settings.json';
const key='conversation:target', other='conversation:other';
if(!['writer','lock-holder'].includes(scenario)) fs.writeFileSync(file,JSON.stringify({permissionModeMap:{...(scenario==='explicit-default'?{}:{[key]:{mode:'standard'}}),[other]:{mode:'acceptEdits'}},permissionModeRevMap:{[key]:['resume-tombstone','resume-nondefault','pruned-turn'].includes(scenario)?1:0}}));
if(scenario==='atomic-write-error'){
  const {mock}=await import('bun:test');
  const originalWrite=fs.writeFileSync;
  mock.module('node:fs',()=>({...fs,writeFileSync:(name,...args)=>{
    if(String(name).endsWith('.transaction.tmp')) throw new Error('fixture EIO during atomic publication');
    return originalWrite(name,...args);
  }}));
}
const rs=await import(root+'/websocket/listener/remote-settings.ts');
const pm=await import(root+'/websocket/listener/permission-mode.ts');
const {handleModeChange}=await import(root+'/websocket/listener/control-inputs.ts');
const {runListenerTurnCleanup}=await import(root+'/websocket/listener/turn-cleanup.ts');
const {handleRuntimeStartCommand}=await import(root+'/websocket/listener/commands/runtime-start.ts');
assert.equal(rs.getRemoteSettingsPath(),file);
const {createRuntime}=await import(root+'/websocket/listener/lifecycle.ts');
const listener=createRuntime();
const scope={agent_id:'fixture-agent',conversation_id:'target'};
const disk=()=>JSON.parse(fs.readFileSync(file,'utf8'));
const state=()=>pm.getOrCreateConversationPermissionModeStateRef(listener,null,'target');
const choose=mode=>handleModeChange({mode},null,listener,scope);
async function cleanup(id='target'){await runListenerTurnCleanup({runtime:{listener,transientChannelRuntimeTools:false},agentId:null,normalizedAgentId:'fixture-agent',conversationId:id,finalized:true});}
function writer(mode){const r=spawnSync(process.execPath,['-e',process.env.FIXTURE_WORKER],{cwd:process.cwd(),env:{...process.env,FIXTURE_SCENARIO:'writer',FIXTURE_MODE:mode},encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stdout+r.stderr);}
const replies=[];const runtime={key:'target',listener,turnLifecycle:{kind:'idle'},queueRuntime:[]};
async function start(mode){await handleRuntimeStartCommand({type:'runtime_start',request_id:'fixture',conversation_id:'target',...(mode?{mode}:{})},{runtime:listener,connectionId:'fixture',socket:null,getOrCreateScopedRuntime:()=>runtime,safeSocketSend:(_,r)=>{replies.push(r);return true;},retrieveConversation:async id=>({id,agent_id:null}),replaySyncStateForRuntime:async()=>{}});return replies.at(-1);}
if(scenario==='lock-holder'){const locks=await import(root+'/websocket/listener/remote-settings-lock.ts');await rs.flushRemoteSettingsWrites();const lock=locks.tryAcquireRemoteSettingsLockSync(file+'.lock');assert.ok(lock);fs.writeFileSync(process.cwd()+'/holder-ready','');const deadline=Date.now()+5000;while(!fs.existsSync(process.cwd()+'/holder-release')){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}locks.releaseRemoteSettingsLockSync(lock);process.exit(0);}
if(scenario==='two-process-lock'){const child=spawn(process.execPath,['-e',process.env.FIXTURE_WORKER],{cwd:process.cwd(),env:{...process.env,FIXTURE_SCENARIO:'lock-holder'},stdio:['ignore','pipe','pipe'],timeout:10000});let childErrors='';child.stderr.on('data',x=>childErrors+=x);const exited=new Promise(resolve=>child.on('exit',resolve));const deadline=Date.now()+5000;while(!fs.existsSync(process.cwd()+'/holder-ready')){assert.ok(Date.now()<deadline,childErrors);await new Promise(r=>setTimeout(r,10));}const p=start('acceptEdits');await new Promise(r=>setTimeout(r,50));assert.equal(replies.length,0);assert.equal(state().mode,'standard');fs.writeFileSync(process.cwd()+'/holder-release','');assert.equal((await p).success,true);assert.equal(await exited,0,childErrors);assert.equal(disk().permissionModeMap[key].mode,'acceptEdits');assert.equal(state().knownRev,1);}
if(scenario==='writer'){await choose(process.env.FIXTURE_MODE);assert.equal(disk().permissionModeMap[key]?.mode??'unrestricted',process.env.FIXTURE_MODE);process.exit(0);}
console.log(JSON.stringify({scenario,home:process.env.HOME,cwd:process.cwd(),backend:process.env.LETTA_LOCAL_BACKEND_DIR,settings:file,updater:process.env.DISABLE_AUTOUPDATER}));
if(scenario==='original-cleanup'){writer('unrestricted');await cleanup();assert.equal(disk().permissionModeMap[key],undefined);assert.equal(state().mode,'unrestricted');}
if(scenario==='explicit-default'){writer('standard');await choose('unrestricted');assert.equal(disk().permissionModeMap[key],undefined);assert.equal(disk().permissionModeRevMap[key],2);assert.equal(state().knownRev,2);}
if(scenario==='double-revision'){await choose('standard');assert.equal(state().knownRev,1);assert.equal(disk().permissionModeRevMap[key],1);writer('unrestricted');await cleanup();assert.equal(disk().permissionModeMap[key],undefined);assert.equal(state().knownRev,2);assert.equal(state().mode,'unrestricted');}
if(scenario==='resume-tombstone'){writer('unrestricted');assert.equal((await start()).success,true);assert.equal(state().mode,'unrestricted');assert.equal(state().knownRev,2);}
if(scenario==='resume-nondefault'){const ref=state();writer('acceptEdits');assert.equal((await start()).success,true);assert.equal(state(),ref);assert.equal(ref.mode,'acceptEdits');assert.equal(ref.knownRev,2);await choose('standard');assert.equal(ref.mode,'standard');assert.equal(ref.knownRev,3);}
if(scenario==='legitimate-turn'){await choose('standard');state().mode='acceptEdits';await cleanup();assert.equal(disk().permissionModeMap[key]?.mode,'acceptEdits');assert.equal(state().knownRev,2);}
if(scenario==='pruned-turn'){const ref=state();ref.mode='unrestricted';await cleanup();assert.equal(disk().permissionModeMap[key],undefined);assert.equal(state(),ref);assert.equal(ref.knownRev,2);const fresh=pm.loadPersistedPermissionModeMap();assert.equal(fresh.get(key).knownRev,2);assert.equal(fresh.get(key).mode,'unrestricted');}
if(scenario==='ack-lock'){fs.writeFileSync(file+'.lock',process.pid+'-fixture-held');const p=start('acceptEdits');await new Promise(r=>setTimeout(r,50));assert.equal(replies.length,0);assert.equal(state().mode,'standard');assert.equal(disk().permissionModeMap[key]?.mode,'standard');fs.rmSync(file+'.lock');assert.equal((await p).success,true);assert.equal(disk().permissionModeMap[key]?.mode,'acceptEdits');assert.equal(state().knownRev,disk().permissionModeRevMap[key]);}
if(scenario==='ack-order'){fs.writeFileSync(file+'.lock',process.pid+'-fixture-held');assert.equal((await start('standard')).success,false);fs.rmSync(file+'.lock');writer('unrestricted');await rs.flushRemoteSettingsWrites();await new Promise(r=>setTimeout(r,300));assert.equal(disk().permissionModeMap[key],undefined);assert.equal(disk().permissionModeRevMap[key],1);}
if(scenario==='read-error'){fs.writeFileSync(file,'{invalid');assert.throws(()=>pm.loadPersistedPermissionModeMap(),/Unable to read/);assert.equal((await start()).success,false);assert.equal(state().mode,'standard');assert.equal(fs.readFileSync(file,'utf8'),'{invalid');fs.writeFileSync(file,JSON.stringify({permissionModeMap:{[key]:{mode:'standard'},[other]:{mode:'acceptEdits'}}}));}
if(scenario==='publish-error'){const snapshot=fs.readFileSync(file,'utf8');fs.renameSync(file,file+'.saved');fs.mkdirSync(file);assert.equal((await start('unrestricted')).success,false);assert.equal(state().mode,'standard');fs.rmdirSync(file);fs.writeFileSync(file,snapshot);await rs.flushRemoteSettingsWrites();assert.equal(disk().permissionModeMap[key]?.mode,'standard');}
if(scenario==='atomic-write-error'){const before=fs.readFileSync(file,'utf8');const reply=await start('unrestricted');assert.equal(reply.success,false);assert.match(reply.error,/fixture EIO/);assert.equal(state().mode,'standard');assert.equal(fs.readFileSync(file,'utf8'),before);await rs.flushRemoteSettingsWrites();assert.equal(fs.readFileSync(file,'utf8'),before);}
if(scenario==='delayed-callback'){fs.writeFileSync(file+'.lock',process.pid+'-fixture-held');const p=cleanup();fs.rmSync(file+'.lock');await choose('unrestricted');await p;assert.equal(state().mode,'unrestricted');assert.equal(state().knownRev,1);assert.equal(disk().permissionModeMap[key],undefined);assert.equal(disk().permissionModeRevMap[key],1);}
if(scenario==='control-error'){const messages=[];const socket={readyState:1,send:text=>messages.push(JSON.parse(text))};fs.writeFileSync(file,'{invalid');await handleModeChange({mode:'unrestricted'},socket,listener,scope);assert.equal(state().mode,'standard');assert.ok(messages.some(x=>JSON.stringify(x).includes('Unable to read remote settings')));assert.ok(!messages.some(x=>JSON.stringify(x).includes('current_permission_mode')));fs.writeFileSync(file,JSON.stringify({permissionModeMap:{[key]:{mode:'standard'},[other]:{mode:'acceptEdits'}}}));}
if(scenario==='pending-local'){await choose('standard');const ref=state();ref.mode='acceptEdits';assert.equal((await start()).success,true);assert.equal(ref.mode,'acceptEdits');await cleanup();assert.equal(disk().permissionModeMap[key].mode,'acceptEdits');}
if(scenario==='legacy'){fs.writeFileSync(file,JSON.stringify({permissionModeMap:{'agent:__unknown__::conversation:default':{mode:'standard'},[other]:{mode:'acceptEdits'}},permissionModeRevMap:{'agent:__unknown__::conversation:default':3}}));listener.permissionModeByConversation=pm.loadPersistedPermissionModeMap();const ref=pm.getOrCreateConversationPermissionModeStateRef(listener,'fixture-a','default');await pm.reconcilePermissionModeFromDisk(listener,'fixture-a','default');assert.equal(ref.mode,'standard');assert.equal(ref.knownRev,3);assert.equal(disk().permissionModeMap['agent:fixture-a::conversation:default'].mode,'standard');assert.equal(disk().permissionModeMap['agent:__unknown__::conversation:default'],undefined);}
if(scenario==='cross-key'){writer('unrestricted');await cleanup('other');assert.equal(disk().permissionModeMap[key],undefined);}
if(scenario==='new-resume'){listener.permissionModeByConversation.delete(key);fs.writeFileSync(file,JSON.stringify({permissionModeMap:{[other]:{mode:'acceptEdits'}}}));assert.equal((await start()).success,true);assert.equal(state().mode,'unrestricted');assert.equal((await start('standard')).success,true);assert.equal((await start()).success,true);assert.equal(state().mode,'standard');assert.equal((await start('unrestricted')).success,true);assert.equal((await start()).success,true);assert.equal(state().mode,'unrestricted');}
if(scenario==='scopes'){await pm.setConversationPermissionMode(listener,'fixture-a','default','standard');await pm.setConversationPermissionMode(listener,'fixture-b','default','acceptEdits');await pm.setConversationPermissionMode(listener,'fixture-a','default','unrestricted');assert.equal(disk().permissionModeMap['agent:fixture-a::conversation:default'],undefined);assert.equal(disk().permissionModeMap['agent:fixture-b::conversation:default'].mode,'acceptEdits');}
assert.equal(disk().permissionModeMap[other]?.mode,'acceptEdits');console.log('PASS '+scenario+' '+JSON.stringify({ram:state(),disk:disk()}));
`;

describe("permission mode native transactions (real handlers)", () => {
  for (const scenario of [
    "original-cleanup",
    "explicit-default",
    "double-revision",
    "resume-tombstone",
    "resume-nondefault",
    "legitimate-turn",
    "pruned-turn",
    "ack-lock",
    "two-process-lock",
    "ack-order",
    "read-error",
    "publish-error",
    "cross-key",
    "new-resume",
    "scopes",
    "atomic-write-error",
    "control-error",
    "delayed-callback",
    "pending-local",
    "legacy",
  ]) {
    test(scenario, () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "permission-transaction-"));
      const home = path.join(cwd, "home");
      mkdirSync(path.join(home, ".letta"), { recursive: true });
      try {
        const result = spawnSync(process.execPath, ["-e", worker], {
          cwd,
          encoding: "utf8",
          timeout: 15000,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: cwd,
            NODE_ENV: "test",
            DO_NOT_TRACK: "1",
            DISABLE_AUTOUPDATER: "1",
            LETTA_DISABLE_PERMISSION_WATCHERS: "1",
            LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
            LETTA_LOCAL_BACKEND_DIR: path.join(cwd, "backend"),
            LETTA_BASE_URL: "http://127.0.0.1:1",
            FIXTURE_SOURCE: sourceRoot,
            FIXTURE_SCENARIO: scenario,
            FIXTURE_WORKER: worker,
          },
        });
        console.log(result.stdout);
        if (result.status !== 0) console.error(result.stderr);
        expect(result.status).toBe(0);
        // Inspect the final artifact too, not just absence of an exception.
        expect(
          JSON.parse(
            readFileSync(
              path.join(home, ".letta", "remote-settings.json"),
              "utf8",
            ),
          ).permissionModeMap["conversation:other"].mode,
        ).toBe("acceptEdits");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 20000);
  }
});
