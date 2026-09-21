const express = require('express')
const { requireAdmin } = require('../middleware/auth')
const supabase = require('../lib/supabase')
const { validateGroupName, isUniqueViolation } = require('../lib/contactGroups')

const router = express.Router()

async function findWorkspaceGroup(id, customerId) {
  const { data, error } = await supabase
    .from('contact_groups')
    .select('id,name,description,color,created_at,total_contacts')
    .eq('id', id)
    .eq('customer_id', customerId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function syncGroupCount(groupId, customerId) {
  const { count, error } = await supabase
    .from('contact_group_members')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId)
  if (error) throw error
  const { error: updateError } = await supabase
    .from('contact_groups')
    .update({ total_contacts: count || 0 })
    .eq('id', groupId)
    .eq('customer_id', customerId)
  if (updateError) throw updateError
  return count || 0
}

function sendDatabaseError(res, error, fallback) {
  if (isUniqueViolation(error)) return res.status(409).json({ error: 'A contact group with that name already exists.' })
  console.error('Contact group operation failed', { code: error?.code, message: error?.message })
  return res.status(500).json({ error: fallback })
}

router.get('/', async (req, res) => {
  const { data: groups, error } = await supabase
    .from('contact_groups')
    .select('id,name,description,color,created_at,total_contacts')
    .eq('customer_id', req.workspace.customerId)
    .order('created_at', { ascending: false })
  if (error) return sendDatabaseError(res, error, 'Could not load contact groups.')

  const ids = (groups || []).map((group) => group.id)
  let members = []
  if (ids.length) {
    const { data, error: membersError } = await supabase
      .from('contact_group_members')
      .select('group_id,contact_id')
      .in('group_id', ids)
    if (membersError) return sendDatabaseError(res, membersError, 'Could not load contact groups.')
    members = data || []
  }
  const counts = members.reduce((result, member) => {
    result[member.group_id] = (result[member.group_id] || 0) + 1
    return result
  }, {})
  res.json((groups || []).map((group) => ({ ...group, member_count: counts[group.id] || 0 })))
})

router.post('/', requireAdmin, async (req, res) => {
  let name
  try { name = validateGroupName(req.body?.name) } catch (error) { return res.status(400).json({ error: error.message }) }

  const { data, error } = await supabase
    .from('contact_groups')
    .insert({ customer_id: req.workspace.customerId, name, total_contacts: 0 })
    .select('id,name,description,color,created_at,total_contacts')
    .single()
  if (error) return sendDatabaseError(res, error, 'Could not create the contact group.')
  res.status(201).json({ ...data, member_count: 0 })
})

router.get('/:groupId/members', async (req, res) => {
  try {
    const group = await findWorkspaceGroup(req.params.groupId, req.workspace.customerId)
    if (!group) return res.status(404).json({ error: 'Contact group not found.' })

    const { data: links, error: linksError } = await supabase
      .from('contact_group_members')
      .select('id,contact_id')
      .eq('group_id', group.id)
    if (linksError) return sendDatabaseError(res, linksError, 'Could not load contact group members.')

    const contactIds = (links || []).map((link) => link.contact_id)
    let contacts = []
    if (contactIds.length) {
      const { data, error } = await supabase
        .from('contacts')
        .select('id,name,phone_number,tag,created_at')
        .eq('customer_id', req.workspace.customerId)
        .in('id', contactIds)
      if (error) return sendDatabaseError(res, error, 'Could not load contact group members.')
      contacts = data || []
    }
    const byId = new Map(contacts.map((contact) => [contact.id, contact]))
    res.json({
      group,
      members: (links || []).map((link) => ({ ...link, contact: byId.get(link.contact_id) })).filter((link) => link.contact)
    })
  } catch (error) {
    return sendDatabaseError(res, error, 'Could not load contact group members.')
  }
})

router.post('/:groupId/members', requireAdmin, async (req, res) => {
  try {
    const group = await findWorkspaceGroup(req.params.groupId, req.workspace.customerId)
    if (!group) return res.status(404).json({ error: 'Contact group not found.' })

    const contactId = String(req.body?.contact_id || '')
    if (!contactId) return res.status(400).json({ error: 'Choose a contact to add.' })
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('customer_id', req.workspace.customerId)
      .maybeSingle()
    if (contactError) return sendDatabaseError(res, contactError, 'Could not add this contact.')
    if (!contact) return res.status(404).json({ error: 'Contact not found in this workspace.' })

    const { data, error } = await supabase
      .from('contact_group_members')
      .insert({ group_id: group.id, contact_id: contact.id })
      .select('id,group_id,contact_id')
      .single()
    if (error?.code === '23505') return res.status(409).json({ error: 'This contact is already in the group.' })
    if (error) return sendDatabaseError(res, error, 'Could not add this contact.')
    const memberCount = await syncGroupCount(group.id, req.workspace.customerId)
    res.status(201).json({ ...data, member_count: memberCount })
  } catch (error) {
    return sendDatabaseError(res, error, 'Could not add this contact.')
  }
})

router.delete('/:groupId/members/:memberId', requireAdmin, async (req, res) => {
  try {
    const group = await findWorkspaceGroup(req.params.groupId, req.workspace.customerId)
    if (!group) return res.status(404).json({ error: 'Contact group not found.' })
    const { data, error } = await supabase
      .from('contact_group_members')
      .delete()
      .eq('id', req.params.memberId)
      .eq('group_id', group.id)
      .select('id')
      .maybeSingle()
    if (error) return sendDatabaseError(res, error, 'Could not remove this contact.')
    if (!data) return res.status(404).json({ error: 'Contact group member not found.' })
    const memberCount = await syncGroupCount(group.id, req.workspace.customerId)
    res.json({ success: true, member_count: memberCount })
  } catch (error) {
    return sendDatabaseError(res, error, 'Could not remove this contact.')
  }
})

router.delete('/:groupId', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('contact_groups')
    .delete()
    .eq('id', req.params.groupId)
    .eq('customer_id', req.workspace.customerId)
    .select('id')
    .maybeSingle()
  if (error) return sendDatabaseError(res, error, 'Could not delete this contact group.')
  if (!data) return res.status(404).json({ error: 'Contact group not found.' })
  res.json({ success: true })
})

module.exports = router
