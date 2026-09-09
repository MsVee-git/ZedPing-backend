const express=require('express')
const router=express.Router()
const supabase=require('../lib/supabase')
router.get('/',async(req,res)=>{const {data,error}=await supabase.from('automations').select('*').eq('customer_id',req.workspace.customerId).order('created_at',{ascending:false});if(error)return res.status(500).json({error:error.message});res.json(data)})
router.post('/',async(req,res)=>{const {trigger_type,trigger_value,message_template,chatbot_flow_id}=req.body;const {data,error}=await supabase.from('automations').insert({customer_id:req.workspace.customerId,trigger_type,trigger_value,message_template,chatbot_flow_id,is_active:true}).select();if(error)return res.status(500).json({error:error.message});res.json(data)})
router.patch('/:id',async(req,res)=>{const {is_active}=req.body;const {data,error}=await supabase.from('automations').update({is_active}).eq('id',req.params.id).eq('customer_id',req.workspace.customerId).select();if(error)return res.status(500).json({error:error.message});if(!data?.length)return res.status(404).json({error:'Automation not found'});res.json(data)})
router.post('/airtable-webhook',(req,res)=>res.status(410).json({error:'This integration is disabled until tenant-specific signed webhook credentials are configured'}))
module.exports=router