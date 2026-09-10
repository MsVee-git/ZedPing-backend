const express = require('express')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = buffer
  }
}))

const { requireWorkspace } = require('./middleware/auth')
const webhookRoutes = require('./routes/webhook')
const messageRoutes = require('./routes/messages')
const contactRoutes = require('./routes/contacts')
const broadcastRoutes = require('./routes/broadcasts')
const automationRoutes = require('./routes/automations')
const catalogRoutes = require('./routes/catalog')
const orderRoutes = require('./routes/orders')
const workspaceRoutes = require('./routes/workspace')

app.use('/webhook', webhookRoutes)
app.use('/messages', requireWorkspace, messageRoutes)
app.use('/contacts', requireWorkspace, contactRoutes)
app.use('/broadcasts', requireWorkspace, broadcastRoutes)
app.use('/automations', requireWorkspace, automationRoutes)
app.use('/catalog', requireWorkspace, catalogRoutes)
app.use('/orders', requireWorkspace, orderRoutes)
app.use('/workspace', requireWorkspace, workspaceRoutes)

app.get('/', (req, res) => {
  res.json({ status: 'ZedPing backend is running' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`ZedPing backend running on port ${PORT}`)
})
