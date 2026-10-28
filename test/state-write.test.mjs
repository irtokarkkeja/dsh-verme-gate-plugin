import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {closure} from './helpers/closure.mjs'
async function setup(t){const dir=await fs.mkdtemp(join(tmpdir(),'gate-state-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=join(dir,'state.json');await fs.writeFile(file,'old');let renames=0,writes=0
 const deps={stateFile:file,dirname,mkdir:fs.mkdir,writeFile:fs.writeFile,open:async(...a)=>{const h=await fs.open(...a);return {writeFile:async(...args)=>{writes++;return h.writeFile(...args)},close:()=>h.close()}},rename:async(...a)=>{renames++;return fs.rename(...a)},rm:fs.rm,randomUUID:()=> 'test-uuid',process,MAX_TMP_RENAME_ATTEMPTS:5,stateDoc:()=>({next:true}),journal:()=>{},messageOf:String}
 return {dir,file,deps,run:()=>closure('saveStateDoc',deps)(),counts:()=>({renames,writes})}
}
test('permanent rename failure preserves old file and removes own tmp',async t=>{const s=await setup(t);s.deps.rename=async()=>{throw Object.assign(Error('full'),{code:'ENOSPC'})};await fs.writeFile(s.file+'.tmp-foreign','keep');await assert.rejects(s.run(),{code:'ENOSPC'});assert.equal(await fs.readFile(s.file,'utf8'),'old');assert.deepEqual((await fs.readdir(s.dir)).sort(),['state.json','state.json.tmp-foreign'])})
test('transient rename retries keep one complete source',async t=>{const s=await setup(t);let n=0;s.deps.rename=async(...a)=>{if(++n<3)throw Object.assign(Error('busy'),{code:'EBUSY'});return fs.rename(...a)};await s.run();assert.equal(n,3);assert.equal(s.counts().writes,1);assert.deepEqual(JSON.parse(await fs.readFile(s.file,'utf8')),{next:true});assert.deepEqual(await fs.readdir(s.dir),['state.json'])})
test('permanent write failure is not retried and partial tmp is cleaned',async t=>{const s=await setup(t);let n=0;s.deps.open=async(...a)=>{const h=await fs.open(...a);return {writeFile:async(...args)=>{n++;await h.writeFile(...args);throw Object.assign(Error('disk full'),{code:'ENOSPC'})},close:()=>h.close()}};await assert.rejects(s.run(),{code:'ENOSPC'});assert.equal(n,1);assert.deepEqual(await fs.readdir(s.dir),['state.json'])})
test('exclusive temp creation never overwrites or removes someone elses file',async t=>{const s=await setup(t);const tmp=s.file+'.tmp-'+process.pid+'-test-uuid';await fs.writeFile(tmp,'foreign');await assert.rejects(s.run(),{code:'EEXIST'});assert.equal(await fs.readFile(tmp,'utf8'),'foreign');assert.equal(await fs.readFile(s.file,'utf8'),'old')})
test('permission refusal opening a preexisting temp never removes it',async t=>{
 const s=await setup(t);const tmp=s.file+'.tmp-'+process.pid+'-test-uuid';await fs.writeFile(tmp,'foreign');s.deps.writeFile=async()=>{throw Object.assign(Error('denied'),{code:'EACCES'})};s.deps.open=async()=>{throw Object.assign(Error('denied'),{code:'EACCES'})};await assert.rejects(s.run(),{code:'EACCES'});assert.equal(await fs.readFile(tmp,'utf8'),'foreign')
})
