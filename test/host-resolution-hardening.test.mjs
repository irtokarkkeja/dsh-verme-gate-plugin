import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {hostModuleUrl} from '../lib/host-packages.js'
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'gate resolve Кирилл '));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir}
function put(dir,path,text){const file=join(dir,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);return file}
function pkg(dir,relative,exportsMap){put(dir,relative+'/package.json',JSON.stringify({name:'@test/pkg',type:'module',exports:exportsMap}));put(dir,relative+'/entry.js','export const ok=true');return join(dir,relative)}
test('active DSH nested dependency wins over prefix and dev mirror',t=>{
 const dir=fixture(t);const dsh=join(dir,'node_modules/@deepseek-ai/dsh');put(dsh,'package.json',JSON.stringify({name:'@deepseek-ai/dsh'}));const argv1=put(dsh,'lib/bin.js','');
 const nested=pkg(dsh,'node_modules/@test/pkg','./entry.js');pkg(dir,'node_modules/@test/pkg','./entry.js')
 const url=hostModuleUrl('@test/pkg','',{roots:[dir],argv1});assert.equal(fileURLToPath(url),join(nested,'entry.js'))
})
test('nested node/import conditions resolve in declaration order',t=>{
 const dir=fixture(t);const p=pkg(dir,'node_modules/@test/pkg',{'.':{browser:'./absent.js',node:{import:'./entry.js'},default:'./absent.js'}})
 assert.equal(fileURLToPath(hostModuleUrl('@test/pkg','',{roots:[dir],argv1:''})),join(p,'entry.js'))
})
test('conditional root export without dot key works',t=>{
 const dir=fixture(t);const p=pkg(dir,'node_modules/@test/pkg',{import:'./entry.js'});assert.equal(fileURLToPath(hostModuleUrl('@test/pkg','',{roots:[dir],argv1:''})),join(p,'entry.js'))
})
test('explicit exports does not leak index.js/main for unexported root',t=>{
 const dir=fixture(t);const p=pkg(dir,'node_modules/@test/pkg',{'./api':'./entry.js'});put(p,'index.js','');assert.throws(()=>hostModuleUrl('@test/pkg','',{roots:[dir],argv1:''}),/export/)
})
test('exported entry must actually exist',t=>{
 const dir=fixture(t);pkg(dir,'node_modules/@test/pkg','./missing.js');assert.throws(()=>hostModuleUrl('@test/pkg','',{roots:[dir],argv1:''}),/missing|exist|найден/)
})
test('export targets cannot escape package directory',t=>{
 const dir=fixture(t);pkg(dir,'node_modules/@test/pkg','../outside.js');assert.throws(()=>hostModuleUrl('@test/pkg','',{roots:[dir],argv1:''}),/target|export/)
})
test('wildcard chooses most specific pattern and honors null blocking',t=>{
 const dir=fixture(t);const p=pkg(dir,'node_modules/@test/pkg',{'./*':'./missing/*.js','./api/*':'./*.js','./api/private':null})
 assert.equal(fileURLToPath(hostModuleUrl('@test/pkg','api/entry',{roots:[dir],argv1:''})),join(p,'entry.js'))
 assert.throws(()=>hostModuleUrl('@test/pkg','api/private',{roots:[dir],argv1:''}),/export/)
})
test('pinned API subpath never falls through to another version',t=>{
 const dir=fixture(t);const selected=pkg(dir,'one/node_modules/@test/pkg',{'.':'./entry.js','./api':'./entry.js'});pkg(dir,'two/node_modules/@test/pkg',{'./api':'./missing.js'})
 assert.equal(fileURLToPath(hostModuleUrl('@test/pkg','api',{packageDir:selected,roots:[join(dir,'two')],argv1:''})),join(selected,'entry.js'))
 assert.throws(()=>hostModuleUrl('@test/pkg','hidden',{packageDir:selected,roots:[join(dir,'two')],argv1:''}),/export/)
})
test('real launcher symlink keeps active host dependency ahead of fallback',t=>{
 const dir=fixture(t);const dsh=join(dir,'active/node_modules/@deepseek-ai/dsh');put(dsh,'package.json',JSON.stringify({name:'@deepseek-ai/dsh'}));const argv1=put(dsh,'lib/bin.js','');const nested=pkg(dsh,'node_modules/@test/pkg','./entry.js');pkg(dir,'fallback/node_modules/@test/pkg','./entry.js');
 const launcher=join(dir,'launch.js');
 try { symlinkSync(argv1,launcher) } catch(error) {
  if(process.platform==='win32' && error.code==='EPERM'){t.skip('File symlink requires Windows Developer Mode or elevated privileges');return}
  throw error
 }
 assert.equal(fileURLToPath(hostModuleUrl('@test/pkg','',{argv1:launcher,roots:[join(dir,'fallback')]})),join(nested,'entry.js'))
})
test('exports arrays skip null and invalid targets like Node',t=>{
 const dir=fixture(t);for(const [i,targets] of [[0,[null,'./entry.js']],[1,['../invalid.js','./entry.js']]]){const prefix=join(dir,String(i));const p=pkg(prefix,'node_modules/@test/pkg',{'.':targets});assert.equal(fileURLToPath(hostModuleUrl('@test/pkg','',{roots:[prefix],argv1:''})),join(p,'entry.js'))}
})
test('exports array does not skip valid but missing file',t=>{const dir=fixture(t);pkg(dir,'node_modules/@test/pkg',{'.':['./missing.js','./entry.js']});assert.throws(()=>hostModuleUrl('@test/pkg','',{roots:[dir],argv1:''}),/missing/)})
