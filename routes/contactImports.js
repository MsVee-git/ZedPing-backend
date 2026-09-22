const express = require('express')
const { requireAdmin } = require('../middleware/auth')
const supabase = require('../lib/supabase')
const { buildImportPlan, safeFilename } = require('../lib/contactImport')

const router = express.Router()

function safeError(res, error, fallback = 'We could not import these contacts. Please try again.') {
  const message = String(error?.message || '')
  if (/Choose one column|column can only|file has no|file must include|supports up to|could not be read|Missing phone/i.test(message)) {
    return res.status(400).json({ error: message })
  }
  console.error('Contact import failed', { code: error?.code, message })
  return res.status(500).json({ error: fallback })
}

async function workspaceContacts(customerId) {
  const { data, error } = await supabase
    .from('contacts')
    .select('id,phone_number,phone_e164,name,email')
    .eq('customer_id', customerId)
  if (error) throw error
  return data || []
}

async function buildForWorkspace(req) {
  const { headers, rows, mapping, country } = req.body || {}
  const contacts = await workspaceContacts(req.workspace.customerId)
  return buildImportPlan({
    headers,
    rows,
    mapping,
    country: country === 'ZM' ? 'ZM' : 'ZM',
    existingContacts: contacts
  })
}

router.post('/preview', requireAdmin, async (req, res) => {
  try {
    const plan = await buildForWorkspace(req)
    res.json({ summary: plan.summary, preview: plan.preview })
  } catch (error) {
    return safeError(res, error, 'We could not review this file. Please check it and try again.')
  }
})

router.post('/confirm', requireAdmin, async (req, res) => {
  try {
    if (req.body?.acknowledged !== true) {
      return res.status(400).json({ error: 'Confirm that these contacts were legitimately collected before importing.' })
    }

    const groupId = req.body?.group_id ? String(req.body.group_id) : null
    if (groupId) {
      const { data: group, error: groupError } = await supabase
        .from('contact_groups')
        .select('id')
        .eq('id', groupId)
        .eq('customer_id', req.workspace.customerId)
        .maybeSingle()
      if (groupError) throw groupError
      if (!group) return res.status(404).json({ error: 'Choose a contact group from this workspace.' })
    }

    const plan = await buildForWorkspace(req)
    if (!plan.entries.length) {
      return res.status(400).json({ error: 'There are no valid contacts to import.' })
    }

    const { data, error } = await supabase.rpc('execute_contact_import', {
      p_customer_id: req.workspace.customerId,
      p_importing_user_id: req.workspace.userId,
      p_group_id: groupId,
      p_filename: safeFilename(req.body?.filename),
      p_source_label: String(req.body?.source_label || '').trim().slice(0, 120),
      p_total_rows: plan.summary.total_rows,
      p_skipped_count: plan.summary.skipped_rows,
      p_entries: plan.entries
    })
    if (error) throw error
    const result = Array.isArray(data) ? data[0] : data
    res.status(201).json({
      import_id: result?.import_id,
      created_count: Number(result?.created_count || 0),
      existing_count: Number(result?.existing_count || 0),
      skipped_count: Number(result?.skipped_count || 0),
      group_members_added: Number(result?.group_members_added || 0),
      summary: plan.summary,
      skipped_rows: plan.preview.filter((row) => ['invalid', 'uninterpretable', 'duplicate'].includes(row.status))
    })
  } catch (error) {
    return safeError(res, error)
  }
})

module.exports = router
