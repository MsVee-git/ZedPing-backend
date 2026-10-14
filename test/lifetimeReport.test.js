const test = require('node:test')
const assert = require('node:assert/strict')
const { loadLifetimeReport } = require('../lib/lifetimeReport')
const cutoff = new Date('2026-10-14T12:00:00Z')
function database(seed, { fail = null, countMissing = false, cappedPage = null } = {}) {
  const calls = []
  return { calls, from(table) {
    const filters = []
    let columns, options, limit = 500, order
    const q = {
      select(c,o) { columns=c; options=o; return q },
      eq(k,v) { filters.push([k,'eq',v]); return q },
      gte(k,v) { filters.push([k,'gte',v]); return q },
      lt(k,v) { filters.push([k,'lt',v]); return q },
      lte(k,v) { filters.push([k,'lte',v]); return q },
      gt(k,v) { filters.push([k,'gt',v]); return q },
      order(k,o) { order=[k,o]; return q },
      limit(n) { limit=n; return q },
      then(resolve,reject) {
        calls.push({table,columns,filters:[...filters],order})
        if (table===fail) return Promise.resolve({error:new Error('query failed')}).then(resolve,reject)
        let rows=(seed[table]||[]).filter(r=>filters.every(([k,op,v])=>op==='eq'?r[k]===v:op==='gt'?r[k]>v:op==='gte'?r[k]>=v:op==='lt'?r[k]<v:r[k]<=v))
        if(options?.head) return Promise.resolve({count:countMissing?null:rows.length,error:null}).then(resolve,reject)
        rows=rows.sort((a,b)=>String(a.id).localeCompare(String(b.id))).slice(0,cappedPage??limit)
        return Promise.resolve({data:rows,error:null}).then(resolve,reject)
      }
    }
    return q
  }}
}
function row(id, extra={}) {return {id,customer_id:'a',created_at:'2026-10-01T00:00:00Z',...extra}}
test('counts every page, excludes other workspaces and future records, preserves missing counters',async()=>{
 const db=database({
  messages:[row('1',{direction:'inbound',from_number:'+260 977 000 001'}),row('2',{direction:'outbound',to_number:'260977000001',status:'accepted'}),row('3',{direction:'outbound',to_number:'260977000002',status:'read'}),row('4',{direction:'outbound',status:null}),row('5',{customer_id:'b'}),row('6',{created_at:'2026-10-15T00:00:00Z'})],
  contacts:[row('1'),row('2',{customer_id:'b'})],
  conversations:[row('1')],automations:[row('1')],
  scheduled_broadcasts:[row('1',{broadcast_name:'Example',status:'completed',sent_count:2,failed_count:0,contacts:[{},{}]}),row('2',{status:'scheduled',sent_count:null,failed_count:null,contacts:null}),row('3',{customer_id:'b'})]
 })
 const r=await loadLifetimeReport(db,'a',{now:cutoff,pageSize:2})
 assert.equal(r.messages.total,4);assert.equal(r.messages.inbound,1);assert.equal(r.messages.outbound,3)
 assert.equal(r.messages.recorded_correspondents,2);assert.equal(r.messages.outbound_statuses.accepted,1)
 assert.equal(r.messages.outbound_statuses.read,1);assert.equal(r.messages.outbound_statuses.not_recorded,1)
 assert.equal(r.current.contacts,1);assert.equal(r.broadcasts.total,2)
 const scheduled=r.broadcasts.campaigns.find(c=>c.id==='2')
 assert.equal(scheduled.accepted,null);assert.equal(scheduled.failed,null);assert.equal(scheduled.recorded_recipients,null)
 assert.equal(r.generated_at,cutoff.toISOString())
 assert.ok(db.calls.every(c=>c.filters.some(([k,op,v])=>k==='customer_id'&&op==='eq'&&v==='a')))
 assert.ok(db.calls.filter(c=>c.table==='messages').length>=3)
 assert.ok(!JSON.stringify(r).includes('260977'))
 assert.ok(!r.broadcasts.campaigns.some(c=>Object.hasOwn(c,'contacts')))
})
test('empty history returns actual zero counts and unavailable time boundaries',async()=>{
 const r=await loadLifetimeReport(database({}),'a',{now:cutoff,pageSize:2})
 assert.equal(r.messages.total,0);assert.equal(r.broadcasts.total,0);assert.equal(r.messages.first_recorded_at,null)
 assert.ok(r.unavailable.includes('Complete historical delivery/read rates'))
})
test('a failed later source rejects the complete report rather than publishing partial totals',async()=>{
 await assert.rejects(loadLifetimeReport(database({},{fail:'scheduled_broadcasts'}),'a',{now:cutoff}),/query failed/)
 await assert.rejects(loadLifetimeReport(database({},{countMissing:true}),'a',{now:cutoff}),/count unavailable/)
})
test('a workspace is required',async()=>{await assert.rejects(loadLifetimeReport(database({}),null),/Workspace required/)})

test('continues even when the database caps each page below the requested size',async()=>{
 const db=database({messages:[row('1',{direction:'inbound'}),row('2',{direction:'outbound',status:'sent'}),row('3',{direction:'inbound'})]},{cappedPage:1})
 const r=await loadLifetimeReport(db,'a',{now:cutoff,pageSize:2});assert.equal(r.messages.total,3)
})

test('period includes start, excludes end, retains current counts and workspace isolation',async()=>{
 const start='2026-09-01T00:00:00Z',end='2026-10-01T00:00:00Z'
 const messages=[row('1',{created_at:'2026-08-31T23:59:59Z'}),row('2',{created_at:start}),row('3',{created_at:'2026-09-30T23:59:59Z'}),row('4',{created_at:end}),row('5',{created_at:start,customer_id:'b'})]
 const r=await loadLifetimeReport(database({messages,scheduled_broadcasts:messages,contacts:[row('1')]}),'a',{now:cutoff,start,end,pageSize:1})
 assert.equal(r.scope,'period');assert.equal(r.messages.total,2);assert.equal(r.broadcasts.total,2);assert.equal(r.current.contacts,1)
 assert.equal(r.period.start_inclusive,'2026-09-01T00:00:00.000Z')
})
test('invalid or incomplete periods reject',async()=>{
 for(const options of [{start:'bad',end:'bad'},{start:'2026-10-01',end:'2026-09-01'},{start:'2026-09-01'}]) await assert.rejects(loadLifetimeReport(database({}),'a',{now:cutoff,...options}),/valid start/)
})

test('delivery evidence distinguishes old sent values and linked campaign receipts',async()=>{
 const db=database({messages:[
 row('1',{direction:'outbound',status:'sent'}),
 row('2',{direction:'outbound',status:'read',broadcast_id:'c',delivery_receipts:{read_at:'2026-10-14T11:00:00Z'}}),
 row('3',{direction:'outbound',status:'failed',broadcast_id:'c',delivery_receipts:{failed_at:'2026-10-14T11:01:00Z',errors:[{code:'131026',title:'Undeliverable'}]}})
 ],scheduled_broadcasts:[row('c'),row('old')]})
 const r=await loadLifetimeReport(db,'a',{now:cutoff})
 assert.equal(r.delivery.unconfirmed,1);assert.equal(r.delivery.delivered,1);assert.equal(r.delivery.read,1);assert.equal(r.delivery.failed,1)
 assert.equal(r.broadcasts.campaigns.find(c=>c.id==='c').delivery.linked_messages,2)
 assert.equal(r.broadcasts.campaigns.find(c=>c.id==='old').delivery,null)
})
