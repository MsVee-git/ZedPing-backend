// Keep PostgREST URLs bounded and never accept a partial audience after an error.
async function loadGroupLinks(db, groupId, columns = 'id,contact_id') {
  const rows = []
  const pageSize = 500
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from('contact_group_members')
      .select(columns).eq('group_id', groupId).order('id')
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if ((data || []).length < pageSize) return rows
  }
}

async function loadWorkspaceContacts(db, workspace, ids, columns) {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  const contacts = []
  // 50 UUIDs fit comfortably below common proxy request-URL limits.
  for (let offset = 0; offset < uniqueIds.length; offset += 50) {
    const { data, error } = await db.from('contacts').select(columns)
      .eq('customer_id', workspace).in('id', uniqueIds.slice(offset, offset + 50))
    if (error) throw error
    contacts.push(...(data || []))
  }
  return contacts
}

module.exports = { loadGroupLinks, loadWorkspaceContacts }
