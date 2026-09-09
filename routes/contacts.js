const express=require('express')
const router=express.Router()
const supabase=require('../lib/supabase')
router.get('/',async(req,res)=>{const {data,error}=await supabase.from('contacts').select('*').eq('customer_id',req.workspace.customerId).order('created_at',{ascending:false});if(error)return res.status(500).json({error:error.message});res.json(data)})
router.post('/',async(req,res)=>{const {name,phone_number,tag,custom_fields}=req.body;const {data,error}=await supabase.from('contacts').insert({name,phone_number,tag,custom_fields,customer_id:req.workspace.customerId}).select();if(error)return res.status(500).json({error:error.message});res.json(data)})
router.post('/upload',async(req,res)=>{const {contacts}=req.body;if(!Array.isArray(contacts))return res.status(400).json({error:'contacts must be an array'});const formatted=contacts.map(c=>({customer_id:req.workspace.customerId,name:c.name||c.Name||'',phone_number:c.phone_number||c.Phone||c.phone||'',tag:c.tag||c.Tag||null,custom_fields:{}}));const {data,error}=await supabase.from('contacts').insert(formatted).select();if(error)return res.status(500).json({error:error.message});res.json({success:true,imported:data.length})})
router.delete('/:id',async(req,res)=>{const {error}=await supabase.from('contacts').delete().eq('id',req.params.id).eq('customer_id',req.workspace.customerId);if(error)return res.status(500).json({error:error.message});res.json({success:true})})
module.exports=router
