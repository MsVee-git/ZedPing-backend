// Model output is review data, never executable instructions or automatically approved knowledge.
function parseExtraction(value) {
 const raw=String(value||'').trim();const json=raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
 try{
  const parsed=JSON.parse(json);
  const text=typeof parsed.text==='string'?parsed.text.trim():Array.isArray(parsed.text)?parsed.text.filter(item=>typeof item==='string').join('\n').trim():'';
  const notes=Array.isArray(parsed.notes)?parsed.notes.map(note=>String(note||'').trim()).filter(Boolean).slice(0,12):[];
  if(text)return {text,notes};
 }catch{}
 return {text:raw||'No reliable business information could be read from this image.',notes:['Please review the extracted information before approval.']};
}
function reviewableExtraction(value){
 const raw=String(value||'').trim();
 return /^(?:```|\{\s*"text"\s*:)/i.test(raw)?parseExtraction(raw).text:raw;
}
module.exports={parseExtraction,reviewableExtraction};
