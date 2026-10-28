import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {buildGatewayRoute} from '../lib/gateway-route.js'
function route(entries,options={}) {
 const piAi={lazyApi:()=>()=>{},createProvider:spec=>spec,InMemoryCredentialStore:class{}}
 return buildGatewayRoute({piAi,loadApi:async()=>({}),dshPi:{PiAiAdapter:class{}},dshLlm:{resolveRetryPolicy:()=>({})},providerId:'dshlab',displayName:'test',baseUrl:'https://example.invalid/v1',resolveKey:async()=>'',modelCatalog:()=>entries,...options})
}
test('GeneralPurpose without metadata receives fallback window 327680',()=>{
 assert.equal(route([{id:'GeneralPurpose'}]).models()[0].contextWindow,327680)
})
test('operator fallback override remains higher priority than package default',()=>{
 assert.equal(route([{id:'GeneralPurpose'}],{defaultContextWindow:360448}).models()[0].contextWindow,360448)
})
test('explicit gateway/model limit is never enlarged by fallback',()=>{
 for(const contextWindow of [131072,1048576]) assert.equal(route([{id:'GeneralPurpose',contextWindow}]).models()[0].contextWindow,contextWindow)
})
test('plugin configuration and route agree on fallback default',()=>{
 const text=readFileSync(new URL('../index.js',import.meta.url),'utf8')
 assert.ok(text.includes('defaultContextWindow: z.number().step(1).default(327680)'))
})
