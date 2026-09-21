const express = require('express')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = buffer
  }
}))

const { requireWorkspace, requireAuthenticated } = require('./middleware/auth')
const webhookRoutes = require('./routes/webhook')
const messageRoutes = require('./routes/messages')
const contactRoutes = require('./routes/contacts')
const contactGroupRoutes = require('./routes/contactGroups')
const contactImportRoutes = require('./routes/contactImports')
const broadcastRoutes = require('./routes/broadcasts')
const automationRoutes = require('./routes/automations')
const catalogRoutes = require('./routes/catalog')
const orderRoutes = require('./routes/orders')
const workspaceRoutes = require('./routes/workspace')
const templateRoutes = require('./routes/templates')
const whatsappConnectionRoutes = require('./routes/whatsappConnections')
const conversationRoutes = require('./routes/conversations')
const contentRoutes = require('./routes/content')
const chatbotFlowRoutes = require('./routes/chatbotFlows')
const aiAgentRoutes = require('./routes/aiAgents')
const { router: teamRoutes, acceptInvitation, previewInvitation } = require('./routes/team')

app.use('/webhook', webhookRoutes)
app.post('/invitations/preview', previewInvitation)
app.post('/invitations/accept', requireAuthenticated, acceptInvitation)
app.use('/messages', requireWorkspace, messageRoutes)
app.use('/contacts/import', requireWorkspace, contactImportRoutes)
app.use('/contacts', requireWorkspace, contactRoutes)
app.use('/contact-groups', requireWorkspace, contactGroupRoutes)
app.use('/broadcasts', requireWorkspace, broadcastRoutes)
app.use('/automations', requireWorkspace, automationRoutes)
app.use('/catalog', requireWorkspace, catalogRoutes)
app.use('/orders', requireWorkspace, orderRoutes)
app.use('/workspace', requireWorkspace, workspaceRoutes)
app.use('/templates', requireWorkspace, templateRoutes)
app.use('/whatsapp-connections', requireWorkspace, whatsappConnectionRoutes)
app.use('/conversations', requireWorkspace, conversationRoutes)
app.use('/content', requireWorkspace, contentRoutes)
app.use('/chatbot-flows', requireWorkspace, chatbotFlowRoutes)
app.use('/ai-agents', requireWorkspace, aiAgentRoutes)
app.use('/team', requireWorkspace, teamRoutes)

app.get('/', (req, res) => {
  res.json({ status: 'ZedPing backend is running' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`ZedPing backend running on port ${PORT}`)
})
