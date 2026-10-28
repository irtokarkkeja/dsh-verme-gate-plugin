import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closure } from './helpers/closure.mjs'
function setup(installed = false) {
  const calls = { saved: [], substitutes: [], reselected: 0 }
  const modelState = { known: true, provider: 'dshlab', allowed: new Set(['allowed']), defaultSwap: { stale: true } }
  const gatewayRoute = { installed, providerId: installed ? 'dshlab' : '' }
  const service = { currentSelection: () => ({provider:'builtin',model:'old'}), saveSelection: async v => calls.saved.push(v) }
  const deps = { modelState, gatewayRoute, modelSyncEnabled:true, cfg:{llmProvider:'dshlab',persistDefaultModelSwap:true,reselectAgentsOnModelLoss:true},
    ctx:{get: name => name === 'agentDefaultModel' ? service : {listProviders:()=>[]}}, defaultGuard:{base:null},
    installDefaultSubstitute:v=>calls.substitutes.push(v),reselectLiveAgents:()=>++calls.reselected,journal:()=>{},log:()=>{},messageOf:String }
  return { calls, modelState, gatewayRoute, service, deps, run:()=>closure('ensureDefaultModel', deps)() }
}
test('failed route never selects, persists or reassigns an unavailable model', async()=>{
  const s=setup(); await s.run()
  assert.deepEqual(s.calls.saved,[]); assert.equal(s.calls.reselected,0)
  assert.deepEqual(s.calls.substitutes,[null]); assert.equal(s.modelState.defaultSwap,null)
})
test('successful route permits normal model selection',async()=>{
  const s=setup(true); await s.run(); assert.deepEqual(s.calls.saved,[{provider:'dshlab',model:'allowed'}])
})
test('route recovery restores normal selection without inventing builtin fallback',async()=>{
  const s=setup(); await s.run(); s.gatewayRoute.installed=true;s.gatewayRoute.providerId='dshlab';await s.run()
  assert.equal(s.calls.saved.length,1)
})
test('empty permissions and disabled sync leave no plugin substitution',async()=>{
  for (const mutate of [s=>s.modelState.allowed.clear(),s=>{s.deps.modelSyncEnabled=false}]) {
    const s=setup(true); mutate(s); await s.run(); assert.deepEqual(s.calls.saved,[]);assert.deepEqual(s.calls.substitutes,[null])
  }
})
test('first connection prefers GeneralPurpose even if GLM is listed first',async()=>{
 const s=setup(true);s.deps.cfg.preferredModel='GeneralPurpose';s.modelState.allowed=new Set(['z-ai/glm-5.3-flash','GeneralPurpose']);s.service.currentSelection=()=>undefined;await s.run();assert.equal(s.calls.saved[0].model,'GeneralPurpose')
})
test('lost selection prefers GeneralPurpose when allowed',async()=>{
 const s=setup(true);s.deps.cfg.preferredModel='GeneralPurpose';s.modelState.allowed=new Set(['z-ai/glm-5.3-flash','GeneralPurpose']);s.service.currentSelection=()=>({provider:'dshlab',model:'removed'});await s.run();assert.equal(s.calls.saved[0].model,'GeneralPurpose')
})
test('available user-selected GLM is not overridden by preferred model',async()=>{
 const s=setup(true);s.deps.cfg.preferredModel='GeneralPurpose';s.modelState.allowed=new Set(['z-ai/glm-5.3-flash','GeneralPurpose']);s.service.currentSelection=()=>({provider:'dshlab',model:'z-ai/glm-5.3-flash'});await s.run();assert.deepEqual(s.calls.saved,[]);assert.equal(s.calls.reselected,0)
})
test('preferred model never expands grants and supports operator override',async()=>{
 for (const [preferred,expected] of [['GeneralPurpose','allowed'],['second','second'],['','allowed']]){const s=setup(true);s.deps.cfg.preferredModel=preferred;s.modelState.allowed.add('second');await s.run();assert.equal(s.calls.saved[0].model,expected)}
})
