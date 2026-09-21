function activeTextKnowledge(rows) {
  return (rows || []).map(row => row?.content_library_items).filter(item =>
    item && item.content_type === 'TEXT' && !item.archived_at
  )
}

module.exports = { activeTextKnowledge }
