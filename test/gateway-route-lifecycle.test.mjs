import {test} from 'node:test'
import assert from 'node:assert/strict'
import {closure} from './helpers/closure.mjs'
function setup(){
 const gatewayRoute={installed:false,handle:null,providerId:'',error:'',piAi:''};const calls={registered:0,released:0,cleanups:[],imports:0};let effectError=false,getError=false,registerError=false,releaseError=false;let wait=null
 const deps={gatewayRoute,modelSyncEnabled:true,cfg:{llmProvider:'dshlab'},ctx:{get:()=>{if(getError)throw Error('get failed');return {registerAdapter:()=>{if(registerError)throw Error('provider conflict');calls.registered++;return ()=>{calls.released++;if(releaseError)throw Error('release failed')}}}},effect:(f)=>{if(effectError)throw Error('effect failed');const clean=f();calls.cleanups.push(clean)}},
 resolveHostPackage:()=>({entryUrl:'file:///fake/pi.js',packageDir:'/fake'}),dshRuntime:{dir:'/fake'},hostModuleUrl:()=>'',hostResolve:()=>'/fake/x.js',pathToFileURL:p=>({href:p}),loadModule:async()=>{calls.imports++;if(wait)await wait;return{}},buildGatewayRoute:()=>({adapter:{}}),llmBaseUrl:()=>'',catalog:{},state:{},modelState:{known:false},log:()=>{},journal:()=>{},messageOf:String,configErrors:[]}
 const run=closure('installGatewayRoute',deps)
 return {gatewayRoute,calls,deps,run,effectError:v=>effectError=v,getError:v=>getError=v,registerError:v=>registerError=v,releaseError:v=>releaseError=v,wait:v=>wait=v}
}
test('effect failure does not leave a registered adapter behind',async()=>{const s=setup();s.effectError(true);await s.run();assert.equal(s.calls.registered-s.calls.released,0);assert.equal(s.gatewayRoute.installed,false);assert.match(s.gatewayRoute.error,/effect failed/);assert.deepEqual(s.deps.configErrors,[])})
test('parallel installation registers only one adapter',async()=>{const s=setup();await Promise.all([s.run(),s.run(),s.run()]);assert.equal(s.calls.registered,1);assert.equal(s.gatewayRoute.installed,true)})
test('dispose is idempotent and clears route state',async()=>{const s=setup();await s.run();for(const clean of s.calls.cleanups){clean();clean()}assert.equal(s.calls.released,1);assert.equal(s.gatewayRoute.installed,false);assert.equal(s.gatewayRoute.providerId,'')})
test('ctx.get failure is reported rather than escaping startup',async()=>{const s=setup();s.getError(true);await assert.doesNotReject(s.run());assert.match(s.gatewayRoute.error,/get failed/)})
test('failed registration can be retried and clears runtime error',async()=>{const s=setup();s.registerError(true);await s.run();assert.match(s.gatewayRoute.error,/provider conflict/);s.registerError(false);await s.run();assert.equal(s.gatewayRoute.installed,true);assert.equal(s.gatewayRoute.error,'');assert.deepEqual(s.deps.configErrors,[])})
test('dispose during imports prevents late registration',async()=>{const s=setup();let unblock; s.wait(new Promise(r=>unblock=r));const pending=s.run();await Promise.resolve();for(const clean of s.calls.cleanups)clean();unblock();await pending;assert.equal(s.calls.registered,0)})
test('disposer failure still clears installed state and remains visible',async()=>{const s=setup();s.releaseError(true);await s.run();for(const clean of s.calls.cleanups)assert.doesNotThrow(()=>clean());assert.equal(s.gatewayRoute.installed,false);assert.match(s.gatewayRoute.error,/release failed/)})
test('catalog refresh retries failed installation before applying model access',async()=>{
 const s=setup();s.registerError(true);await s.run();s.registerError(false);let applied=false
 const apply=closure('applyModelAccess',{catalog:{tokens:new Map()},cfg:{llmProvider:'dshlab',llmSecretRef:''},modelState:{},llmBaseUrl:()=>'',modelSyncEnabled:true,installGatewayRoute:s.run,installDefaultSubstitute:()=>{},isOwnRef:()=>false,journal:()=>{}})
 const refresh=closure('refreshModelCatalog',{serialise:f=>f(),applyModelAccess:async(...args)=>{await apply(...args);assert.equal(s.gatewayRoute.installed,true);applied=true},state:{activeToken:'test'},modelState:{known:false},ctx:{emit:()=>{}},journal:()=>{},log:()=>{},messageOf:String})
 await refresh('manual');assert.equal(applied,true);assert.equal(s.gatewayRoute.error,'')
})
test('repeated retries keep a single lifecycle hook and cannot install after dispose',async()=>{
 const s=setup();s.registerError(true);for(let i=0;i<3;i++)await s.run();s.registerError(false);await s.run();assert.equal(s.calls.cleanups.length,1);for(const cleanup of s.calls.cleanups)cleanup();await s.run();assert.equal(s.calls.registered,1)
})
test('token application retries route installation even before a key is configured',async()=>{
 const s=setup();const apply=closure('applyModelAccess',{catalog:{tokens:new Map()},cfg:{llmProvider:'dshlab',llmSecretRef:''},modelState:{},llmBaseUrl:()=>'',modelSyncEnabled:true,installGatewayRoute:s.run,installDefaultSubstitute:()=>{},isOwnRef:()=>false,journal:()=>{}});await apply('');assert.equal(s.gatewayRoute.installed,true)
})
