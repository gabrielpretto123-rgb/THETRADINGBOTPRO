const express = require('express');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const userBots = new Map();

// Configurazioni base
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Crea cartelle necessarie se non esistono
if (!fs.existsSync('./public')) fs.mkdirSync('./public');
if (!fs.existsSync('./configs')) fs.mkdirSync('./configs');

// ========== CLASSI ========== //
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

    static calculateEMA(prices, period) {
        const k = 2 / (period + 1);
        let ema = [prices[0]];
        for (let i = 1; i < prices.length; i++) {
            ema.push(prices[i] * k + ema[i - 1] * (1 - k));
        }
        return ema;
    }

    static calculateStdDev(prices, period) {
        const sma = this.sma(prices, period);
        let sum = 0;
        for (let i = prices.length - period; i < prices.length; i++) {
            sum += Math.pow(prices[i] - sma[sma.length - 1], 2);
        }
        return Math.sqrt(sum / period);
    }
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
    
    static async rsiOversold(prices, config) {
        if (prices.length < 20) return 'hold';
        const rsi = TechnicalIndicators.rsi(prices);
        if (rsi[rsi.length - 1] < 30) return 'buy';
        if (rsi[rsi.length - 1] > 70) return 'sell';
        return 'hold';
    }

    static async momentum(prices, config) {
        if (prices.length < 10) return 'hold';
        const recentPrices = prices.slice(-10);
        const momentum = (recentPrices[9] - recentPrices[0]) / recentPrices[0];
        if (momentum > 0.02) return 'buy';
        if (momentum < -0.02) return 'sell';
        return 'hold';
    }

    static async meanReversion(prices, config) {
        if (prices.length < 20) return 'hold';
        const sma20 = TechnicalIndicators.sma(prices, 20);
        const deviation = (prices[prices.length - 1] - sma20[sma20.length - 1]) / sma20[sma20.length - 1];
        if (deviation < -0.03) return 'buy';
        if (deviation > 0.03) return 'sell';
        return 'hold';
    }

    static async emaCrossover(prices, config) {
        if (prices.length < 50) return 'hold';
        const ema10 = TechnicalIndicators.calculateEMA(prices, 10);
        const ema30 = TechnicalIndicators.calculateEMA(prices, 30);
        if (ema10[ema10.length-2] <= ema30[ema30.length-2] && ema10[ema10.length-1] > ema30[ema30.length-1]) return 'buy';
        if (ema10[ema10.length-2] >= ema30[ema30.length-2] && ema10[ema10.length-1] < ema30[ema30.length-1]) return 'sell';
        return 'hold';
    }

    static async bollingerBands(prices, config) {
        if (prices.length < 20) return 'hold';
        const sma = TechnicalIndicators.sma(prices, 20);
        const stdDev = TechnicalIndicators.calculateStdDev(prices, 20);
        const upperBand = sma[sma.length-1] + (2 * stdDev);
        const lowerBand = sma[sma.length-1] - (2 * stdDev);
        if (prices[prices.length-1] < lowerBand) return 'buy';
        if (prices[prices.length-1] > upperBand) return 'sell';
        return 'hold';
    }
}

class UserTradingBot {
    constructor(userId, config) {
        this.userId = userId;
        this.config = config;
        this.isActive = false;
        this.stats = { totalTrades: 0, wins: 0, losses: 0, totalPL: 0, dailyPL: 0, monthlyPL: 0, dailyTrades: 0 };
        this.positions = new Map();
        this.priceHistory = new Map();
        this.alpaca = new Alpaca({
            keyId: config.apiKey,
            secretKey: config.secretKey,
            paper: config.mode === 'paper',
            usePolygon: false
        });
        if (config.telegramToken) {
            this.telegram = new TelegramBot(config.telegramToken, { polling: false });
            this.setupTelegramCommands();
        }
    }

    async start() {
        this.isActive = true;
        await this.sendTelegramMessage(`🚀 BOT AVVIATO!\n⚙️ Modalità: ${this.config.mode.toUpperCase()}\n📈 Strategia: ${this.config.strategy}`);
        this.tradingLoop();
    }

    stop() {
        this.isActive = false;
        this.sendTelegramMessage('⏹️ Bot fermato');
    }

    async tradingLoop() {
        while (this.isActive) {
            try {
                await this.processTradingCycle();
                await new Promise(resolve => setTimeout(resolve, 120000 + Math.random() * 180000));
            } catch (error) {
                console.error(`Errore ciclo trading:`, error);
                await new Promise(resolve => setTimeout(resolve, 300000));
            }
        }
    }

    async processTradingCycle() {
        if (this.stats.dailyTrades >= this.config.maxTrades) return;
        for (const symbol of this.config.symbols) {
            if (!this.isActive) break;
            try {
                await this.processSymbol(symbol);
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (error) {
                console.error(`Errore processando ${symbol}:`, error);
            }
        }
    }

    async processSymbol(symbol) {
        const currentPrice = await this.getCurrentPrice(symbol);
        if (!this.priceHistory.has(symbol)) this.priceHistory.set(symbol, []);
        const prices = this.priceHistory.get(symbol);
        prices.push(currentPrice);
        if (prices.length > 100) prices.shift();
        
        const signal = await this.getTradeSignal(symbol, prices);
        if (signal === 'buy') await this.executeBuy(symbol, currentPrice);
        else if (signal === 'sell') await this.executeSell(symbol, currentPrice);
        
        await this.checkPositions(symbol, currentPrice);
    }

    async getCurrentPrice(symbol) {
        try {
            if (this.config.mode === 'paper') {
                const basePrice = { 'AAPL': 150, 'TSLA': 200, 'NVDA': 400, 'MSFT': 300, 'GOOGL': 130, 'AMZN': 140 };
                return (basePrice[symbol] || 100) * (1 + (Math.random() - 0.5) * 0.04);
            } else {
                const trade = await this.alpaca.getLatestTrade(symbol);
                return trade.price;
            }
        } catch (error) {
            console.error(`Errore prezzo ${symbol}:`, error);
            return 100;
        }
    }

    async getTradeSignal(symbol, prices) {
        const strategyMap = {
            'sma_crossover': TradingStrategies.smacrossover,
            'rsi_oversold': TradingStrategies.rsiOversold,
            'momentum': TradingStrategies.momentum,
            'mean_reversion': TradingStrategies.meanReversion,
            'ema_crossover': TradingStrategies.emaCrossover,
            'bollinger_bands': TradingStrategies.bollingerBands
        };
        return await strategyMap[this.config.strategy](prices, this.config) || 'hold';
    }

    async executeBuy(symbol, price) {
        const quantity = Math.floor(this.config.tradeAmount / price);
        if (quantity < 1) return;

        try {
            const order = this.config.mode === 'live' 
                ? await this.alpaca.createOrder({
                    symbol, qty: quantity, side: 'buy', type: 'market', time_in_force: 'day'
                })
                : { id: Date.now(), symbol, qty: quantity, side: 'buy', filled_avg_price: price, status: 'filled' };

            this.positions.set(`${symbol}_${order.id}`, {
                symbol, quantity, entryPrice: price, side: 'buy', timestamp: new Date(), orderId: order.id
            });

            this.stats.totalTrades++;
            this.stats.dailyTrades++;
            
            await this.sendTelegramMessage(
                `📈 ACQUISTO ${symbol}\n💰 ${quantity} azioni\n💵 $${price.toFixed(2)}\n🛑 Stop: $${(price * (1 - this.config.stopLoss/100)).toFixed(2)}`
            );
        } catch (error) {
            console.error(`Errore acquisto ${symbol}:`, error);
            await this.sendTelegramMessage(`❌ Errore acquisto ${symbol}: ${error.message}`);
        }
    }

    async executeSell(symbol, price) {
        const position = Array.from(this.positions.values())
            .find(pos => pos.symbol === symbol && pos.side === 'buy');
        if (!position) return;

        try {
            const pl = (price - position.entryPrice) * position.quantity;
            this.stats.totalPL += pl;
            this.stats.dailyPL += pl;
            this.stats.monthlyPL += pl;
            pl > 0 ? this.stats.wins++ : this.stats.losses++;

            if (this.config.mode === 'live') {
                await this.alpaca.createOrder({
                    symbol, qty: position.quantity, side: 'sell', type: 'market', time_in_force: 'day'
                });
            }

            this.positions.delete(`${symbol}_${position.orderId}`);
            
            await this.sendTelegramMessage(
                `${pl > 0 ? '✅' : '❌'} VENDITA ${symbol}\n📈 Entrata: $${position.entryPrice.toFixed(2)}\n📉 Uscita: $${price.toFixed(2)}\n💵 P&L: $${pl.toFixed(2)}`
            );
        } catch (error) {
            console.error(`Errore vendita ${symbol}:`, error);
            await this.sendTelegramMessage(`❌ Errore vendita ${symbol}: ${error.message}`);
        }
    }

    async checkPositions(symbol, currentPrice) {
        const positions = Array.from(this.positions.values()).filter(pos => pos.symbol === symbol);
        for (const pos of positions) {
            const percentChange = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
            if (percentChange <= -this.config.stopLoss) {
                await this.executeSell(symbol, currentPrice);
                await this.sendTelegramMessage(`🛑 STOP LOSS ${symbol} a $${currentPrice.toFixed(2)}`);
            } else if (percentChange >= this.config.takeProfit) {
                await this.executeSell(symbol, currentPrice);
                await this.sendTelegramMessage(`🎯 TAKE PROFIT ${symbol} a $${currentPrice.toFixed(2)}`);
            }
        }
    }

    async sendTelegramMessage(message) {
        if (!this.telegram || !this.config.chatId) return;
        try {
            await this.telegram.sendMessage(
                this.config.chatId, 
                `🤖 TradingBot Pro\n📊 ${this.config.strategy.toUpperCase()}\n\n${message}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Errore Telegram:', error);
        }
    }

    async setupTelegramCommands() {
        if (!this.telegram || !this.config.chatId) return;
        
        try {
            await this.telegram.setMyCommands([
                { command: 'start', description: 'Avvia il bot' },
                { command: 'stop', description: 'Ferma il bot' },
                { command: 'stats', description: 'Mostra statistiche' },
                { command: 'positions', description: 'Posizioni aperte' }
            ]);
        } catch (error) {
            console.error('Errore setup comandi Telegram:', error);
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

// ========== API ROUTES ========== //
app.post('/api/start-bot', async (req, res) => {
    try {
        const { userId, config } = req.body;
        if (!config.apiKey || !config.secretKey) return res.status(400).json({ error: 'API keys richieste' });
        
        if (userBots.has(userId)) userBots.get(userId).stop();
        
        const bot = new UserTradingBot(userId, config);
        userBots.set(userId, bot);
        await bot.start();
        
        res.json({ success: true, message: 'Bot avviato' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/stop-bot', (req, res) => {
    try {
        const { userId } = req.body;
        if (userBots.has(userId)) userBots.get(userId).stop();
        res.json({ success: true, message: 'Bot fermato' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/bot-status/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        res.json(userBots.has(userId) ? userBots.get(userId).getStats() : { isActive: false });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        activeBots: Array.from(userBots.values()).filter(bot => bot.isActive).length,
        uptime: process.uptime()
    });
});

// Gestione delle rotte
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Avvio server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Server avviato su porta ${PORT}`);
    console.log(`👉 Frontend: http://localhost:${PORT}`);
});