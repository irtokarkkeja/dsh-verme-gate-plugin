import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,existsSync,readFileSync,symlinkSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {findHostDshDir,resolveHostPackage} from '../lib/host-packages.js'
import {topLevelFunction} from './helpers/closure.mjs'
function put(path,text){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text)}
test('production host anchor follows launcher realpath before fallback installation',t=>{
 const dir=mkdtempSync(join(tmpdir(),'gate-anchor-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const active=join(dir,'active/node_modules/@deepseek-ai/dsh'),fallback=join(dir,'fallback/node_modules/@deepseek-ai/dsh')
 for(const [dsh,version] of [[active,'0.2.1-rc.2'],[fallback,'0.2.1-rc.4']]){
  put(join(dsh,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version,exports:{'./package.json':'./package.json'}}));put(join(dsh,'lib/bin.js'),'')
  for(const spec of ['@test/host','@deepseek-ai/dsh-mcp-client']){put(join(dsh,'node_modules',spec,'package.json'),JSON.stringify({name:spec,main:'index.cjs'}));put(join(dsh,'node_modules',spec,'index.cjs'),'')}
 }
 const launcher=join(dir,'bin/dsh');mkdirSync(dirname(launcher),{recursive:true});
 try { symlinkSync(join(active,'lib/bin.js'),launcher) } catch(error) {
  if(process.platform==='win32' && error.code==='EPERM'){t.skip('File symlink requires Windows Developer Mode or elevated privileges');return}
  throw error
 }
 const deps={process:{argv:['node',launcher]},createRequire,join,dirname,realpathSync,existsSync,readFileSync,findHostDshDir,hostInstallRoots:()=>[join(dir,'fallback')]}
 const hostResolve=topLevelFunction('hostResolve',deps);const hostPackageRoot=topLevelFunction('hostPackageRoot',deps)
 const detect=topLevelFunction('detectDshRuntime',{...deps,hostResolve,hostPackageRoot});const runtime=detect()
 assert.equal(runtime.dir,active);assert.equal(runtime.version,'0.2.1-rc.2');assert.equal(hostResolve('@test/host'),join(active,'node_modules/@test/host/index.cjs'))
 assert.equal(resolveHostPackage('@test/host','',{dshDir:runtime.dir,argv1:launcher,roots:[join(dir,'fallback')]}).packageDir,join(active,'node_modules/@test/host'))
})
