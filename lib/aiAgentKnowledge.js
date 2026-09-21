function activeTextKnowledge(rows) {
  return (rows || []).map(row => row?.content_library_items).filter(item =>
    item && item.content_type === 'TEXT' && !item.archived_at
  )
}

function knowledgeSnapshot(items) {
  return (items || []).map(item => ({
    id: item.id,
    name: item.name,
    text_content: String(item.text_content || '').slice(0, 3000)
  }))
}

module.exports = { activeTextKnowledge, knowledgeSnapshot }
