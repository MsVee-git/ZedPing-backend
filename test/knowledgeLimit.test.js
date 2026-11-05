const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('ten approved workspace sources are accepted, eleven rejected and foreign sources refused',async()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../routes/aiAgents.js'),'utf8');
 const limit=source.match(/const MAX_KNOWLEDGE_ITEMS = \d+/)[0];const fn=source.slice(source.indexOf('async function selectedKnowledge('),source.indexOf('async function readConfig('));
 let wrong=false;const ctx={supabase:{},resolveEligibleKnowledge:async(db,workspace,ids)=>{assert.equal(workspace,'workspace');return wrong?[]:ids.map(id=>({id}));}};vm.createContext(ctx);vm.runInContext(limit+';'+fn+';this.run=selectedKnowledge;',ctx);
 const ids=Array.from({length:10},(_,i)=>'source-'+i);assert.equal((await ctx.run('workspace',ids)).length,10);await assert.rejects(()=>ctx.run('workspace',[...ids,'eleven']),/no more than 10/);wrong=true;await assert.rejects(()=>ctx.run('workspace',['foreign']),/from this workspace/);
});
