import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const page=readFileSync(new URL('../page.html',import.meta.url),'utf8')
const banner=page.slice(page.indexOf('function banner()'),page.indexOf('function render()'))
test('legacy page shows route error and removes banner after recovery',()=>{
 const element={innerHTML:''},state={models:{route:{error:'missing <module>'}}};const run=Function('state','document','esc',banner+';return banner') (state,{getElementById:()=>element},text=>String(text).replaceAll('<','&lt;'))
 run();assert.match(element.innerHTML,/missing &lt;module>/);state.models.route.error='';run();assert.equal(element.innerHTML,'')
})
