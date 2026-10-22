const { test } = require('node:test')
const assert = require('node:assert/strict')
const { loadGroupLinks, loadWorkspaceContacts } = require('../lib/groupAudience')

function database({ links = [], failAt = -1 } = {}) {
  const calls = []
  return { calls, from(table) {
    const call = { table }; calls.push(call)
    const query = {
      select(value) { call.columns = value; return this },
      eq(key,value) { (call.filters ||= {})[key] = value; return this },
      order(key) { call.order = key; return this },
      async range(first,last) { call.range=[first,last]; return {data:links.slice(first,last+1)} },
      async in(key,ids) {
        call.ids=ids
        if(calls.length===failAt)return {error:new Error('database unavailable')}
        return {data:ids.map(id=>({id}))}
      }
    }
    return query
  } }
}
test('398 contacts are complete and every request stays workspace scoped and bounded', async()=>{
  const db=database(); const ids=Array.from({length:398},(_,i)=>String(i))
  const contacts=await loadWorkspaceContacts(db,'workspace-a',ids,'id,name')
  assert.equal(contacts.length,398)
  assert.equal(db.calls.length,8)
  assert.ok(db.calls.every(call=>call.ids.length<=50 && call.filters.customer_id==='workspace-a'))
  assert.deepEqual(contacts.map(row=>row.id),ids)
})
test('large groups load beyond the default database row limit', async()=>{
  const links=Array.from({length:1201},(_,i)=>({id:String(i),contact_id:String(i)}))
  const db=database({links})
  assert.deepEqual(await loadGroupLinks(db,'group-a'),links)
  assert.equal(db.calls.length,3)
  assert.ok(db.calls.every(call=>call.filters.group_id==='group-a' && call.order==='id'))
})
test('empty and duplicate IDs do not create duplicate contact requests', async()=>{
  const db=database()
  assert.deepEqual(await loadWorkspaceContacts(db,'a',[],'id'),[])
  assert.equal(db.calls.length,0)
  assert.equal((await loadWorkspaceContacts(db,'a',['x','x',null],'id')).length,1)
})
test('failed batches reject the whole audience rather than returning a partial result', async()=>{
  const db=database({failAt:2})
  await assert.rejects(()=>loadWorkspaceContacts(db,'a',Array.from({length:100},(_,i)=>String(i)),'id'),/database unavailable/)
})
