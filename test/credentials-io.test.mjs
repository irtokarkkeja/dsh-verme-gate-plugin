import {test} from 'node:test'
import assert from 'node:assert/strict'
import {closure} from './helpers/closure.mjs'
import {applyRefWithLock} from '../lib/credentials-emergency.js'
function setup(){let text=JSON.stringify({version:1,refs:{OTHER:'keep'}});let writes=0;const atomic={withFileLock:async(file,fn)=>fn(),writeFileAtomic:async(file,next)=>{writes++;text=next}};const deps={credentialsFile:()=>'/fake/credentials.yaml',loadModule:async()=>atomic,hostResolve:()=>'/fake/atomic.js',pathToFileURL:p=>({href:p}),readFile:async()=>text,writeFile:async(file,next)=>{writes++;text=next},rename:async()=>{},randomUUID:()=> 'id',applyRefWithLock,YAML:{parse:JSON.parse,stringify:JSON.stringify},log:()=>{},messageOf:String};return {deps,atomic,run:()=>closure('emergencyCredentialWrite',deps)('MCP_ACCESS_A','new'),writes:()=>writes,text:()=>text}}
test('missing atomic module never writes an unlocked credential store',async()=>{const s=setup();s.deps.loadModule=async()=>undefined;assert.equal(await s.run(),false);assert.equal(s.writes(),0)})
test('partial atomic API never falls back to unlocked/plain writes',async()=>{for(const key of ['withFileLock','writeFileAtomic']){const s=setup();delete s.atomic[key];assert.equal(await s.run(),false);assert.equal(s.writes(),0)}})
test('read permission failure never becomes an empty credential store',async()=>{const s=setup();s.deps.readFile=async()=>{throw Object.assign(Error('denied'),{code:'EACCES'})};assert.equal(await s.run(),false);assert.equal(s.writes(),0);assert.equal(JSON.parse(s.text()).refs.OTHER,'keep')})
test('successful locked write preserves other refs',async()=>{const s=setup();assert.equal(await s.run(),true);assert.deepEqual(JSON.parse(s.text()).refs,{OTHER:'keep',MCP_ACCESS_A:'new'})})
test('atomic resolver failure is handled with no writes',async()=>{const s=setup();s.deps.hostResolve=()=>{throw Error('missing package')};assert.equal(await s.run(),false);assert.equal(s.writes(),0)})
