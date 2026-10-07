const express = require('express')

const app = express()
const router = express.Router()

router.get('/users/:id', (req, res) => res.json({}))
router.post('/users', (req, res) => res.json({}))
app.use('/api', router)
app.get('/health', (req, res) => res.send('ok'))

module.exports = app
