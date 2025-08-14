const express = require('express');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Low, JSONFile } = require('lowdb');

// INIT
const app = express();
const userBots = new Map();
const SECRET_KEY = 'mysecr3tk3yforth3b0t4';

// DB Config (MODIFICATO per lowdb v1.0.0)
const adapter = new JSONFile('db.json');
const db = new Low(adapter);

(async function initDB() {
  await db.read();
  db.data ||= { users: [], trades: [], configs: [] };
  await db.write();
})();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CLASSI (TUTTE LE TUE 500+ RIGHE - MODIFICATE SOLO I RIFERIMENTI AL DB)
class TechnicalIndicators {
  static sma(prices, period) {
    const result = [];
    for (let i = period - 1; i < prices.length; i++) {
      const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    }
    return result;
  }

  static rsi(prices, period = 14) {
    const gains = [];
    const losses = [];
    for (let i = 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? -change : 0);
    }
    const avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // ... [ALTRI METODI ESISTENTI] ...
}

class TradingStrategies {
  static async smacrossover(prices, config) {
    if (prices.length < 50) return 'hold';
    const sma20 = TechnicalIndicators.sma(prices, 20);
    const sma50 = TechnicalIndicators.sma(prices, 50);
    if (sma20[sma20.length - 2] <= sma50[sma50.length - 2] && sma20[sma20.length - 1] > sma50[sma50.length - 1]) return 'buy';
    if (sma20[sma20.length - 2] >= sma50[sma50.length - 2] && sma20[sma20.length - 1] < sma50[sma50.length - 1]) return 'sell';
    return 'hold';
  }

  // ... [ALTRE STRATEGIE ESISTENTI] ...
}

class UserTradingBot {
  constructor(userId, config) {
    this.userId = userId;
    this.config = config;
    this.alpaca = new Alpaca({
      keyId: config.apiKey,
      secretKey: config.secretKey,
      paper: config.mode === 'paper'
    });
    
    if (config.telegramToken) {
      this.telegram = new TelegramBot(config.telegramToken, { polling: false });
    }
    
    // MODIFICATO per lowdb v1.0.0
    this.loadTradeHistory();
  }

  async loadTradeHistory() {
    await db.read();
    const history = db.data.trades
      .filter(t => t.userId === this.userId)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    if (history.length) {
      this.tradeHistory = history[0].trades || [];
      this.stats = history[0].stats || this.stats;
    }
  }

  async saveTradeHistory() {
    await db.read();
    db.data.trades.push({
      userId: this.userId,
      trades: this.tradeHistory,
      stats: this.stats,
      timestamp: new Date()
    });
    await db.write();
  }

  // ... [ALTRI METODI ESISTENTI - RIMANGONO IDENTICI] ...
}

// API ROUTES (MODIFICATI SOLO I RIFERIMENTI AL DB)
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    await db.read();
    
    const exists = db.data.users.some(u => u.email === email);
    if (exists) return res.status(400).json({ error: 'User exists' });

    const user = {
      id: Date.now().toString(),
      email,
      password: await bcrypt.hash(password, 10)
    };

    db.data.users.push(user);
    await db.write();

    const token = jwt.sign({ userId: user.id }, SECRET_KEY);
    res.json({ success: true, token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ... [ALTRE ROUTES CON MODIFICHE SIMILI PER lowdb] ...

// START SERVER
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ TradingBot Pro ONLINE su http://localhost:${PORT}`);
  console.log(`📈 Versione: 2.0 | LowDB v1.0.0`);
});