const test=require('node:test'),assert=require('node:assert/strict');
const {templateKnowledge}=require('../lib/templateKnowledge');const {resolveEligibleKnowledge,knowledgeSnapshot}=require('../lib/aiAgentKnowledge');
const item={id:'saved',template_id:'provider',content_type:'WHATSAPP_TEMPLATE_REFERENCE',name:'Respray offer'};
const template={id:'provider',name:'respray_offer',language:'en',status:'APPROVED',components:[{type:'HEADER',text:'November offer'},{type:'BODY',text:'Respray from K13000. Hello {{1}}'},{type:'FOOTER',text:'Subject to inspection.'}]};
test('approved template facts and placeholders keep immutable source provenance',()=>{
 const knowledge=templateKnowledge(item,template);assert.match(knowledge.text_content,/K13000/);assert.match(knowledge.text_content,/Never invent/);const frozen=knowledgeSnapshot([knowledge]);assert.equal(frozen[0].source_type,'template');assert.equal(frozen[0].provenance.template_id,'provider');knowledge.text_content='Changed';assert.match(frozen[0].text_content,/K13000/);
 for(const status of ['PENDING','REJECTED','PAUSED'])assert.equal(templateKnowledge(item,{...template,status}),null);
 assert.equal(templateKnowledge(item,{...template,id:'another-workspace'}),null);assert.equal(templateKnowledge(item,{...template,components:[]}),null);
});
test('template resolution loads only the authenticated workspace catalog',async()=>{
 const db={from:()=>{const q={select:()=>q,eq:(key,value)=>{assert.equal(key,'customer_id');assert.equal(value,'workspace');return q;},is:()=>q,in:async()=>({data:[item],error:null})};return q;}};
 const rows=await resolveEligibleKnowledge(db,'workspace',['saved'],{loadTemplates:async workspace=>{assert.equal(workspace,'workspace');return {kind:'ok',templates:[template]};}});assert.equal(rows.length,1);assert.equal(rows[0].source_type,'template');
 const missing=await resolveEligibleKnowledge(db,'workspace',['saved'],{loadTemplates:async()=>({kind:'ok',templates:[]})});assert.equal(missing.length,0);
});
