const test = require('node:test')
const assert = require('node:assert/strict')
const { createGupshupConnectionStore } = require('../lib/gupshupConnectionStore')

test('a generated workspace app name is persisted once and reused after a retry', async () => {
  const rows = []
  const db = {
    from: () => ({
      insert: async row => { if (!rows.length) rows.push(row); return { error: null } },
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows[0] || null, error: null }) }) }) })
    })
  }
  const store = createGupshupConnectionStore(db)
  const first = await store.ensure({ customerId: 'customer1', connectionId: 'connection1', walletId: 'wallet-1', businessName: 'Example & Company' })
  const second = await store.ensure({ customerId: 'customer1', connectionId: 'connection1', walletId: 'wallet-1', businessName: 'Changed workspace name' })
  assert.equal(rows.length, 1)
  assert.equal(first.app_name, second.app_name)
  assert.match(first.app_name, /^ZedPingExampleCompany[A-Fa-f0-9]{16}$/)
})

