function templateKnowledge(item,template){
 if(!template || String(template.id)!==String(item.template_id) || String(template.status||'').toUpperCase()!=='APPROVED')return null;
 const parts=(template.components||[]).filter(part=>['HEADER','BODY','FOOTER'].includes(String(part.type||'').toUpperCase()) && typeof part.text==='string').map(part=>part.text.trim()).filter(Boolean);
 if(!parts.length)return null;
 const text=parts.join('\n\n');
 return {...item,text_content:text+(/\{\{/.test(text)?'\n\nTemplate placeholders are customer-specific values, not business facts. Never invent their values.':''),source_type:'template',source_content_item_id:item.id,provenance:{source_type:'template',template_id:String(template.id),template_name:template.name,template_language:template.language}};
}
module.exports={templateKnowledge};
