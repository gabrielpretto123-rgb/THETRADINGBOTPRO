require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

// Configurazione
const config = require('./config/default.json');
const { createDailyRotateLogger } = require('./utils/logger');

// Inizializzazione app
const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// Logging
const logger = createDailyRotateLogger();
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

// Database
require('./database/initialize')();

// API Documentation
const swaggerDocument = YAML.load('./api/docs/swagger.yaml');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/bot', require('./routes/bot'));
app.use('/api/data', require('./routes/data'));
app.use('/api/backup', require('./routes/backup'));

// Static Files
app.use(express.static(path.join(__dirname, '../../public')));

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    version: config.version,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Error Handling
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start Server
app.listen(PORT, () => {
  logger.info(`🚀 Server v${config.version} running on port ${PORT}`);
  logger.info(`📄 API Docs: http://localhost:${PORT}/api-docs`);
  
  // Start background services
  require('./utils/backup').startBackupService();
  require('./utils/market').startMarketHoursWatcher();
});