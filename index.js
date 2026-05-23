const express = require('express')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json())

const webhookRoutes = require('./routes/webhook')
const messageRoutes = require('./routes/messages')
const contactRoutes = require('./routes/contacts')
const broadcastRoutes = require('./routes/broadcasts')
const automationRoutes = require('./routes/automations')

app.use('/webhook', webhookRoutes)
app.use('/messages', messageRoutes)
app.use('/contacts', contactRoutes)
app.use('/broadcasts', broadcastRoutes)
app.use('/automations', automationRoutes)

app.get('/', (req, res) => {
  res.json({ status: 'ZedPing backend is running' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`ZedPing backend running on port ${PORT}`)
  console.log('VERIFY_TOKEN:', process.env.VERIFY_TOKEN)
})
