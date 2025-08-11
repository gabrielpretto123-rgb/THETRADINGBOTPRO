const express = require('express');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Store user configurations and bot instances
const userBots = new Map();
const userConfigs = new Map();

// Technical indicators helper
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
}

// Trading strategies
class TradingStrategies {
    static async smacrossover(prices, config) {
        if (prices.length < 50) return 'hold';
        
        const sma20 = TechnicalIndicators.sma(prices, 20);
        const sma50 = TechnicalIndicators.sma(prices, 50);
        
        const current20 = sma20[sma20.length - 1];
        const current50 = sma50[sma50.length - 1];
        const prev20 = sma20[sma20.length - 2];
        const prev50 = sma50[sma50.length - 2];
        
        if (prev20 <= prev50 && current20 > current50) return 'buy';
        if (prev20 >= prev50 && current20 < current50) return 'sell';
        
        return 'hold';
    }
    
    static async rsiOversold(prices, config) {
        if (prices.length < 20) return 'hold';
        
        const rsi = TechnicalIndicators.rsi(prices);
        const currentRSI = rsi[rsi.length - 1];
        
        if (currentRSI < 30) return 'buy';   // Oversold
        if (currentRSI > 70) return 'sell';  // Overbought
        
        return 'hold';
    }
    
    static async momentum(prices, config) {
        if (prices.length < 10) return 'hold';
        
        const recentPrices = prices.slice(-10);
        const momentum = (recentPrices[9] - recentPrices[0]) / recentPrices[0];
        
        if (momentum > 0.02) return 'buy';   // 2% positive momentum
        if (momentum < -0.02) return 'sell'; // 2% negative momentum
        
        return 'hold';
    }
    
    static async meanReversion(prices, config) {
        if (prices.length < 20) return 'hold';
        
        const sma20 = TechnicalIndicators.sma(prices, 20);
        const currentPrice = prices[prices.length - 1];
        const currentSMA = sma20[sma20.length - 1];
        
        const deviation = (currentPrice - currentSMA) / currentSMA;
        
        if (deviation < -0.03) return 'buy';  // Price 3% below SMA
        if (deviation > 0.03) return 'sell';  // Price 3% above SMA
        
        return 'hold';
    }
}

// User Bot Class
class UserTradingBot {
    constructor(userId, config) {
        this.userId = userId;
        this.config = config;
        this.isActive = false;
        this.stats = {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            totalPL: 0,
            dailyPL: 0,
            monthlyPL: 0,
            dailyTrades: 0
        };
        this.positions = new Map();
        this.priceHistory = new Map();
        
        // Initialize Alpaca
        this.alpaca = new Alpaca({
            keyId: config.apiKey,
            secretKey: config.secretKey,
            paper: config.mode === 'paper',
            usePolygon: false
        });
        
        // Initialize Telegram
        if (config.telegramToken) {
            this.telegram = new TelegramBot(config.telegramToken, { polling: false });
        }
    }
    
    async start() {
        if (this.isActive) return;
        
        this.isActive = true;
        console.log(`🚀 Bot avviato per utente ${this.userId}`);
        
        await this.sendTelegramMessage(
            `🚀 BOT AVVIATO!\n\n` +
            `⚙️ Modalità: ${this.config.mode.toUpperCase()}\n` +
            `💰 Budget per trade: $${this.config.tradeAmount}\n` +
            `📈 Strategia: ${this.config.strategy}\n` +
            `🎯 Simboli: ${this.config.symbols.join(', ')}\n` +
            `🛑 Stop Loss: ${this.config.stopLoss}%\n` +
            `🎯 Take Profit: ${this.config.takeProfit}%\n` +
            `🔄 Status: ATTIVO 24/7`
        );
        
        this.tradingLoop();
    }
    
    stop() {
        this.isActive = false;
        console.log(`⏹️ Bot fermato per utente ${this.userId}`);
        this.sendTelegramMessage('⏹️ Bot fermato dall\'utente');
    }
    
    async tradingLoop() {
        while (this.isActive) {
            try {
                await this.processTradingCycle();
                
                // Wait between trades (2-5 minutes)
                const delay = 120000 + Math.random() * 180000;
                await new Promise(resolve => setTimeout(resolve, delay));
                
            } catch (error) {
                console.error(`Errore nel ciclo di trading per ${this.userId}:`, error);
                await this.sendTelegramMessage(`❌ Errore: ${error.message}`);
                
                // Wait longer on error
                await new Promise(resolve => setTimeout(resolve, 300000)); // 5 minutes
            }
        }
    }
    
    async processTradingCycle() {
        // Check daily trade limit
        if (this.stats.dailyTrades >= this.config.maxTrades) {
            return;
        }
        
        for (const symbol of this.config.symbols) {
            if (!this.isActive) break;
            
            try {
                await this.processSymbol(symbol);
            } catch (error) {
                console.error(`Errore processando ${symbol}:`, error);
            }
            
            // Small delay between symbols
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    async processSymbol(symbol) {
        // Get current price and update history
        const currentPrice = await this.getCurrentPrice(symbol);
        
        if (!this.priceHistory.has(symbol)) {
            this.priceHistory.set(symbol, []);
        }
        
        const prices = this.priceHistory.get(symbol);
        prices.push(currentPrice);
        
        // Keep only last 100 prices
        if (prices.length > 100) {
            prices.shift();
        }
        
        // Get trading signal
        const signal = await this.getTradeSignal(symbol, prices);
        
        if (signal === 'buy') {
            await this.executeBuy(symbol, currentPrice);
        } else if (signal === 'sell') {
            await this.executeSell(symbol, currentPrice);
        }
        
        // Check existing positions for stop loss/take profit
        await this.checkPositions(symbol, currentPrice);
    }
    
    async getCurrentPrice(symbol) {
        try {
            if (this.config.mode === 'paper') {
                // Simulate realistic price movement
                const basePrice = { 'AAPL': 150, 'TSLA': 200, 'NVDA': 400, 'MSFT': 300, 'GOOGL': 130, 'AMZN': 140 };
                const base = basePrice[symbol] || 100;
                const volatility = 0.02; // 2% volatility
                const change = (Math.random() - 0.5) * 2 * volatility;
                return base * (1 + change);
            } else {
                const trade = await this.alpaca.getLatestTrade(symbol);
                return trade.price;
            }
        } catch (error) {
            console.error(`Errore ottenendo prezzo per ${symbol}:`, error);
            return 100; // Fallback price
        }
    }
    
    async getTradeSignal(symbol, prices) {
        const strategyMap = {
            'sma_crossover': TradingStrategies.smacrossover,
            'rsi_oversold': TradingStrategies.rsiOversold,
            'momentum': TradingStrategies.momentum,
            'mean_reversion': TradingStrategies.meanReversion
        };
        
        const strategy = strategyMap[this.config.strategy];
        if (!strategy) return 'hold';
        
        return await strategy(prices, this.config);
    }
    
    async executeBuy(symbol, price) {
        const quantity = Math.floor(this.config.tradeAmount / price);
        if (quantity < 1) return;
        
        try {
            let order = null;
            
            if (this.config.mode === 'live') {
                order = await this.alpaca.createOrder({
                    symbol: symbol,
                    qty: quantity,
                    side: 'buy',
                    type: 'market',
                    time_in_force: 'day'
                });
            } else {
                // Simulate order
                order = {
                    id: Date.now(),
                    symbol: symbol,
                    qty: quantity,
                    side: 'buy',
                    filled_avg_price: price,
                    status: 'filled'
                };
            }
            
            // Track position
            this.positions.set(`${symbol}_${order.id}`, {
                symbol: symbol,
                quantity: quantity,
                entryPrice: price,
                side: 'buy',
                timestamp: new Date(),
                orderId: order.id
            });
            
            this.stats.totalTrades++;
            this.stats.dailyTrades = (this.stats.dailyTrades || 0) + 1;
            
            await this.sendTelegramMessage(
                `📈 ACQUISTO ESEGUITO\n\n` +
                `🎯 Simbolo: ${symbol}\n` +
                `💰 Quantità: ${quantity}\n` +
                `💵 Prezzo: $${price.toFixed(2)}\n` +
                `💸 Valore: $${(quantity * price).toFixed(2)}\n` +
                `🛑 Stop Loss: $${(price * (1 - this.config.stopLoss / 100)).toFixed(2)}\n` +
                `🎯 Take Profit: $${(price * (1 + this.config.takeProfit / 100)).toFixed(2)}`
            );
            
        } catch (error) {
            console.error(`Errore nell'acquisto:`, error);
            await this.sendTelegramMessage(`❌ Errore acquisto ${symbol}: ${error.message}`);
        }
    }
    
    async executeSell(symbol, price) {
        // Find open long positions for this symbol
        const openPositions = Array.from(this.positions.values())
            .filter(pos => pos.symbol === symbol && pos.side === 'buy');
        
        if (openPositions.length === 0) return;
        
        const position = openPositions[0]; // Sell oldest position first
        
        try {
            let order = null;
            
            if (this.config.mode === 'live') {
                order = await this.alpaca.createOrder({
                    symbol: symbol,
                    qty: position.quantity,
                    side: 'sell',
                    type: 'market',
                    time_in_force: 'day'
                });
            } else {
                // Simulate order
                order = {
                    id: Date.now(),
                    symbol: symbol,
                    qty: position.quantity,
                    side: 'sell',
                    filled_avg_price: price,
                    status: 'filled'
                };
            }
            
            // Calculate P&L
            const pl = (price - position.entryPrice) * position.quantity;
            this.stats.totalPL += pl;
            this.stats.dailyPL += pl;
            this.stats.monthlyPL += pl;
            
            if (pl > 0) {
                this.stats.wins++;
            } else {
                this.stats.losses++;
            }
            
            // Remove position
            this.positions.delete(`${symbol}_${position.orderId}`);
            
            const emoji = pl > 0 ? '✅' : '❌';
            const result = pl > 0 ? 'PROFITTO' : 'PERDITA';
            
            await this.sendTelegramMessage(
                `${emoji} VENDITA ESEGUITA - ${result}\n\n` +
                `🎯 Simbolo: ${symbol}\n` +
                `💰 Quantità: ${position.quantity}\n` +
                `📈 Prezzo entrata: $${position.entryPrice.toFixed(2)}\n` +
                `📉 Prezzo uscita: $${price.toFixed(2)}\n` +
                `💵 P&L: ${pl > 0 ? '+' : ''}$${pl.toFixed(2)}\n` +
                `📊 P&L Totale: $${this.stats.totalPL.toFixed(2)}\n` +
                `🎯 Win Rate: ${((this.stats.wins / this.stats.totalTrades) * 100).toFixed(1)}%`
            );
            
        } catch (error) {
            console.error(`Errore nella vendita:`, error);
            await this.sendTelegramMessage(`❌ Errore vendita ${symbol}: ${error.message}`);
        }
    }
    
    async checkPositions(symbol, currentPrice) {
        const positions = Array.from(this.positions.values())
            .filter(pos => pos.symbol === symbol);
        
        for (const position of positions) {
            const priceDiff = currentPrice - position.entryPrice;
            const percentChange = (priceDiff / position.entryPrice) * 100;
            
            // Check stop loss
            if (position.side === 'buy' && percentChange <= -this.config.stopLoss) {
                await this.executeSell(symbol, currentPrice);
                await this.sendTelegramMessage(`🛑 Stop Loss attivato per ${symbol}`);
            }
            
            // Check take profit
            if (position.side === 'buy' && percentChange >= this.config.takeProfit) {
                await this.executeSell(symbol, currentPrice);
                await this.sendTelegramMessage(`🎯 Take Profit attivato per ${symbol}`);
            }
        }
    }
    
    async sendTelegramMessage(message) {
        if (!this.telegram || !this.config.chatId) return;
        
        try {
            await this.telegram.sendMessage(this.config.chatId, `🤖 TradingBot Pro\n\n${message}`);
        } catch (error) {
            console.error('Errore Telegram:', error);
        }
    }
    
    getStats() {
        return {
            ...this.stats,
            isActive: this.isActive,
            openPositions: this.positions.size,
            symbols: this.config.symbols
        };
    }
}

// API Routes
app.post('/api/start-bot', async (req, res) => {
    try {
        const { userId, config } = req.body;
        
        // Validate configuration
        if (!config.apiKey || !config.secretKey) {
            return res.status(400).json({ error: 'API keys richieste' });
        }
        
        // Stop existing bot if running
        if (userBots.has(userId)) {
            userBots.get(userId).stop();
        }
        
        // Create and start new bot
        const bot = new UserTradingBot(userId, config);
        userBots.set(userId, bot);
        userConfigs.set(userId, config);
        
        await bot.start();
        
        res.json({ success: true, message: 'Bot avviato con successo' });
        
    } catch (error) {
        console.error('Errore avvio bot:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/stop-bot', (req, res) => {
    try {
        const { userId } = req.body;
        
        if (userBots.has(userId)) {
            userBots.get(userId).stop();
            userBots.delete(userId);
        }
        
        res.json({ success: true, message: 'Bot fermato' });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/bot-status/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        
        if (userBots.has(userId)) {
            const bot = userBots.get(userId);
            res.json(bot.getStats());
        } else {
            res.json({ isActive: false, totalTrades: 0, totalPL: 0 });
        }
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/save-config', (req, res) => {
    try {
        const { userId, config } = req.body;
        userConfigs.set(userId, config);
        
        // Save to file for persistence
        const configFile = `./configs/user_${userId}.json`;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/load-config/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        
        if (userConfigs.has(userId)) {
            res.json(userConfigs.get(userId));
        } else {
            // Try to load from file
            const configFile = `./configs/user_${userId}.json`;
            if (fs.existsSync(configFile)) {
                const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
                userConfigs.set(userId, config);
                res.json(config);
            } else {
                res.json({});
            }
        }
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    const activeBots = Array.from(userBots.values()).filter(bot => bot.isActive).length;
    res.json({
        status: 'online',
        activeBots: activeBots,
        totalUsers: userBots.size,
        uptime: process.uptime()
    });
});

// Create configs directory
if (!fs.existsSync('./configs')) {
    fs.mkdirSync('./configs');
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 TradingBot Pro Server avviato sulla porta ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔧 Health Check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Shutdown in corso...');
    
    // Stop all bots
    for (const bot of userBots.values()) {
        bot.stop();
    }
    
    process.exit(0);
});