function initialDelivery() {
 return {delivered:0,read:0,failed:0,sent_pending:0,accepted_pending:0,unconfirmed:0,submission_failures:0,first_receipt_at:null,last_receipt_at:null,failure_reasons:Object.create(null)}
}
function addDelivery(metrics,row) {
 if(row.direction!=='outbound')return
 const receipt=row.delivery_receipts||{}
 if(receipt.read_at || receipt.delivered_at) {metrics.delivered++;if(receipt.read_at)metrics.read++}
 else if(receipt.failed_at){metrics.failed++}
 else if(receipt.sent_at)metrics.sent_pending++
 else if(row.status==='accepted')metrics.accepted_pending++
 else if(row.status==='failed')metrics.submission_failures++
 else metrics.unconfirmed++
 for(const k of ['sent_at','delivered_at','read_at','failed_at'])if(receipt[k]){
  const at=receipt[k]; if(!metrics.first_receipt_at||at<metrics.first_receipt_at)metrics.first_receipt_at=at;
  if(!metrics.last_receipt_at||at>metrics.last_receipt_at)metrics.last_receipt_at=at;
 }
 if(receipt.failed_at && !receipt.read_at && !receipt.delivered_at){
  const errors=Array.isArray(receipt.errors)&&receipt.errors.length?receipt.errors:[{code:'unknown',title:'Reason not supplied'}]
  for(const e of errors){const key=String(e.code||'unknown')+': '+String(e.title||'Reason not supplied');metrics.failure_reasons[key]=(metrics.failure_reasons[key]||0)+1}
 }
}
module.exports={initialDelivery,addDelivery}
