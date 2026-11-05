const test=require('node:test'),assert=require('node:assert/strict');
const {parseExtraction,reviewableExtraction}=require('../lib/knowledgeExtraction');
test('JSON fences and text arrays become readable facts without automatic approval',()=>{
 assert.deepEqual(parseExtraction('```json\n{"text":["Sedan respray K13000","Dents affect price"],"notes":["Confirm dates"]}\n```'),{text:'Sedan respray K13000\nDents affect price',notes:['Confirm dates']});
 assert.equal(reviewableExtraction('```json\n{"text":"Opening hours 08:00","notes":[]}\n```'),'Opening hours 08:00');
 assert.equal(reviewableExtraction('Prices subject to inspection'),'Prices subject to inspection');
 assert.match(parseExtraction('{incomplete').notes[0],/review/);
});
