const Alpaca = require('@alpacahq/alpaca-trade-api');
const TelegramBot = require('node-telegram-bot-api');
const moment = require('moment-timezone');
const tf = require('@tensorflow/tfjs-node');
const { TechnicalIndicators, TradingStrategies } = require('./Strategies');
const { calculateAdvancedMetrics } = require('../utils/metrics');

class TradingBot {
  constructor(userId, config) {
    this.userId = userId;
    this.config = {
      ...config,
      symbols: config.autoSymbols ? [] : config.symbols
    };
    this.isActive = false;
    this.isSimulation = config.mode === 'paper';
    this.version = '2.0.0';
    
    // Statistics
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPL: 0,
      dailyPL: 0,
      monthlyPL: 0,
      tradeReturns: [],
      maxDrawdown: 0,
      sharpeRatio: 0
    };
    
    // State
    this.positions = new Map();
    this.priceHistory = new Map();
    this.tradeHistory = [];
    this.mlModel = null;
    
    // Initialize services
    this.initBroker();
    this.initTelegram();
    this.initMLModel();
  }

  async initBroker() {
    this.alpaca = new Alpaca({
      keyId: this.config.apiKey,
      secretKey: this.config.secretKey,
      paper: this.isSimulation,
      usePolygon: false
    });
    
    if (this.config.autoSymbols) {
      await this.updateAutoSymbols();
    }
  }

  initTelegram() {
    if (this.config.telegramToken && this.config.chatId) {
      this.telegram = new TelegramBot(this.config.telegramToken, { polling: false });
      this.sendTelegramMessage(`🤖 TradingBot Pro v${this.version} inizializzato`);
    }
  }

  async initMLModel() {
    if (this.config.useML) {
      try {
        this.mlModel = await tf.loadLayersModel(this.config.mlModelUrl);
      } catch (error) {
        this.sendTelegramMessage(`❌ Errore caricamento modello ML: ${error.message}`);
      }
    }
  }

  async start() {
    this.isActive = true;
    await this.sendTelegramMessage(
      `🚀 BOT AVVIATO!\n` +
      `⚙️ Modalità: ${this.config.mode.toUpperCase()}\n` +
      `📈 Strategia: ${this.config.strategy}\n` +
      `🔄 Auto-simboli: ${this.config.autoSymbols ? 'ON' : 'OFF'}`
    );
    
    // Avvia loop principale
    this.tradingInterval = setInterval(() => this.tradingLoop(), 60000);
    this.statsInterval = setInterval(() => this.updateStats(), 300000);
    
    // Prima esecuzione immediata
    await this.tradingLoop();
  }

  async stop() {
    this.isActive = false;
    clearInterval(this.tradingInterval);
    clearInterval(this.statsInterval);
    
    await this.sendTelegramMessage('⏹️ Bot fermato');
    await this.closeAllPositions();
    
    // Salva lo stato prima di chiudere
    await this.backupState();
  }

  async tradingLoop() {
    if (!this.isActive || !this.isMarketOpen()) return;
    
    try {
      if (this.config.autoSymbols && moment().hour() % 6 === 0) {
        await this.updateAutoSymbols();
      }
      
      await this.processTradingCycle();
    } catch (error) {
      this.sendTelegramMessage(`❌ Errore ciclo trading: ${error.message}`);
    }
  }

  async processTradingCycle() {
    if (this.stats.dailyTrades >= this.config.maxTrades) return;
    
    for (const symbol of this.config.symbols) {
      if (!this.isActive) break;
      
      try {
        await this.processSymbol(symbol);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Rate limiting
      } catch (error) {
        this.sendTelegramMessage(`❌ Errore processando ${symbol}: ${error.message}`);
      }
    }
  }

  // ... (altri metodi rimangono simili ma con le migliorie descritte prima) ...

  async backupState() {
    const backupData = {
      config: this.config,
      stats: this.stats,
      positions: Array.from(this.positions.values()),
      tradeHistory: this.tradeHistory
    };
    
    // Salva localmente
    fs.writeFileSync(`./backups/bot_${this.userId}.json`, JSON.stringify(backupData));
    
    // Salva su Google Drive
    if (this.config.googleBackup) {
      await require('../utils/backup').uploadToGoogleDrive(
        `bot_${this.userId}_${moment().format('YYYYMMDD_HHmmss')}.json`,
        backupData
      );
    }
  }

  getAdvancedMetrics() {
    return calculateAdvancedMetrics(this.stats);
  }
}

module.exports = TradingBot;