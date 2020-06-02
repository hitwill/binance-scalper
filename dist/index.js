"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mathjs_1 = require("mathjs");
const dotenv = require("dotenv");
const binance_api_node_1 = require("binance-api-node");
dotenv.config();
const client = binance_api_node_1.default({
    apiKey: process.env.API_KEY,
    apiSecret: process.env.API_SECRET,
});
//config vars
let channelLengthMultiple = 2; //multiple of standard dev long channel
let spendFractionPerTrade = 0.01;
//end config
let priceTicker = []; //hold a list of recent prices
let quantile = { upper: Infinity, lower: 0 };
let findEntry = false;
let orders = [];
let currentFee = { maker: Infinity, taker: Infinity };
let assets = {
    quoteAsset: {
        name: process.env.QUOTE_ASSET,
        precision: 0,
        minPrice: Infinity,
        maxPrice: 0,
        tickSize: 0,
        takeProfitPips: 0,
        balance: null,
        minNotional: Infinity,
    },
    baseAsset: {
        name: process.env.BASE_ASSET,
        precision: 0,
        minQty: Infinity,
        maxQty: 0,
        stepSize: 0,
        balance: null,
    },
};
let tradingSymbol = assets.baseAsset.name + assets.quoteAsset.name;
async function start() {
    Promise.all([
        getExchangeInfo(),
        getBalances(),
        getOpenOrders(),
    ]).then((values) => {
        assets.quoteAsset.takeProfitPips = calcTakeProfitPips();
        listenAccount();
        listenMarket(); //start listening
    });
}
async function getBalances() {
    let accountInfo = await client.accountInfo();
    let balances = accountInfo['balances'];
    for (let i = 0, size = balances.length; i < size; i++) {
        let balance = balances[i];
        if (balance.asset == assets.baseAsset.name)
            assets.baseAsset.balance = Number(balance.free);
        if (balance.asset == assets.quoteAsset.name)
            assets.quoteAsset.balance = Number(balance.free);
        if (assets.baseAsset.balance !== null &&
            assets.quoteAsset.balance !== null)
            break;
    }
}
async function getExchangeInfo() {
    let exchangeInfo = await client.exchangeInfo();
    let fees = await client.tradeFee();
    let symbol = getSymbol(exchangeInfo);
    extractFees(fees.tradeFee);
    extractRules(symbol);
}
function getSymbol(exchangeInfo) {
    let symbol;
    for (let i = 0, size = exchangeInfo.symbols.length; i < size; i++) {
        symbol = exchangeInfo.symbols[i];
        if (symbol.symbol == tradingSymbol)
            break;
    }
    return symbol;
}
function extractFees(fees) {
    for (let i = 0, size = fees.length; i < size; i++) {
        let fee = fees[i];
        if (fee.symbol == tradingSymbol) {
            currentFee.maker = fee.maker;
            currentFee.taker = fee.taker;
            break;
        }
    }
}
function extractRules(symbol) {
    assets.baseAsset.precision = symbol.baseAssetPrecision;
    assets.quoteAsset.precision = symbol.quoteAssetPrecision;
    for (let i = 0, size = symbol.filters.length; i < size; i++) {
        let filter = symbol.filters[i];
        switch (filter.filterType) {
            case 'LOT_SIZE':
                assets.baseAsset.minQty = Number(filter.minQty);
                assets.baseAsset.maxQty = Number(filter.maxQty);
                assets.baseAsset.stepSize = Number(filter.stepSize);
                break;
            case 'PRICE_FILTER':
                assets.quoteAsset.minPrice = Number(filter.minPrice);
                assets.quoteAsset.maxPrice = Number(filter.maxPrice);
                assets.quoteAsset.tickSize = Number(filter.tickSize);
                break;
            case 'MIN_NOTIONAL':
                assets.quoteAsset.minNotional = Number(filter.minNotional);
                break;
        }
    }
}
function addPriceToTicker(price) {
    priceTicker.unshift(Number(price));
}
function calcStandardDev() {
    let standardDeviation = 0;
    let minTickerLength = 3;
    let finalTickerLength = Infinity;
    let newTicker = []; // we'll resize the ticker to fit the standard dev we can trade in
    for (let tickerLength = 1, size = priceTicker.length; tickerLength <= size; tickerLength++) {
        findEntry = false;
        newTicker.push(priceTicker[tickerLength - 1]);
        if (tickerLength < minTickerLength)
            continue;
        if (!isEvenlyDistributed(newTicker))
            continue; //needs to be distributed around mean **over time**
        standardDeviation = mathjs_1.std(newTicker, 'biased');
        //multiply deviate by 2 because it's one end, middle, then other end
        if (standardDeviation * 2 >= assets.quoteAsset.takeProfitPips) {
            if (finalTickerLength == Infinity)
                finalTickerLength = tickerLength * channelLengthMultiple;
            if (tickerLength >= finalTickerLength) {
                findEntry = true;
                break; //ticker is long enough to trust the deviation
            }
        }
    }
    priceTicker = newTicker; // resize the ticker
}
function isEvenlyDistributed(ticker) {
    //points can not go up in one straight gradient, but
    let average = mathjs_1.mean(ticker);
    let normalized;
    let wasPositive = null;
    let switched = 0; //number of times values crossed the average
    let dataPoints = ticker.length;
    for (let i = 0; i < dataPoints; i++) {
        let isPositive = null;
        normalized = ticker[i] - average; // make average 'zero point'
        if (normalized > 0)
            isPositive = true;
        if (normalized < 0)
            isPositive = false;
        if (isPositive !== wasPositive)
            switched++;
        wasPositive = isPositive;
    }
    if (switched / dataPoints >= 0.4) {
        return true;
    }
    else {
        return false;
    }
}
function calcQuantile() {
    quantile.lower = toPrecision(mathjs_1.quantileSeq(priceTicker, 0.01), assets.quoteAsset.precision, 'DOWN');
    quantile.upper = toPrecision(mathjs_1.quantileSeq(priceTicker, 0.99), assets.quoteAsset.precision, 'UP');
}
function toPrecision(num, digits, roundType) {
    let precise;
    let str = String(num);
    let tail;
    let lastDigit = str.indexOf('.') + digits + 1;
    tail = Number(str.slice(lastDigit, lastDigit + 1));
    switch (roundType) {
        case 'UP':
            if (tail > 0) {
                precise =
                    Number(str.slice(0, lastDigit)) +
                        Number('0.'.padEnd(digits + 1, '0') + '1');
            }
            else {
                precise = Number(str.slice(0, lastDigit));
            }
            break;
        case 'DOWN':
            precise = Number(str.slice(0, lastDigit));
            break;
        case 'NORMAL':
            precise = Number(Number(num).toFixed(digits)); //round as normail
            break;
    }
    return precise;
}
function calcMinProfitPips() {
    //formula below comes from: profit = volume(sellingPrice = buyingPrice).((100-fee)/100)
    let profit = assets.quoteAsset.tickSize; //just one pip
    let pips = (100 * profit) / (100 - currentFee.taker); //convert to pips
    pips = toPrecision(pips, assets.quoteAsset.tickSize.toString().split('.')[1].length, 'UP'); //set precission and round it up
    return pips;
}
function calcTakeProfitPips() {
    let minProfit = calcMinProfitPips(); //our takeProfit is just the mininimum profit we can get (scalping)
    return minProfit; //we can add rules to increase profit later
}
function findpositionsToExit(takeProfitBuyOrder, takeProfitSellOrder) {
    //exit orders that are disimilar to next ones we'll make
    let entryType = { buy: true, sell: true };
    for (let i = 0, size = orders.length; i < size; i++) {
        switch (orders[i].orderSide) {
            case 'BUY':
                if (orders[i].orderPrice != quantile.lower ||
                    orders[i].orderStopPrice != takeProfitBuyOrder) {
                    exitUnenteredPositions(orders[i].orderId);
                }
                else {
                    entryType.buy = false;
                }
                break;
            case 'SELL':
                if (orders[i].orderPrice != quantile.upper ||
                    orders[i].orderStopPrice != takeProfitSellOrder) {
                    exitUnenteredPositions(orders[i].orderId);
                }
                else {
                    entryType.sell = false;
                }
                break;
        }
    }
    return entryType;
}
function getEntryQuantity(side, price) {
    //cross reference api with these rules: https://www.binance.com/en/trade-rule
    let quantity = 0;
    switch (side) {
        case 'BUY':
            quantity =
                (assets.quoteAsset.balance * spendFractionPerTrade) / price;
            break;
        case 'SELL':
            quantity = assets.baseAsset.balance * spendFractionPerTrade;
            break;
    }
    if (quantity * price < assets.quoteAsset.minNotional) {
        quantity = assets.quoteAsset.minNotional / price;
    }
    let significantDigits = assets.baseAsset.stepSize.toString().split('.')[1]
        .length;
    quantity = toPrecision(quantity, significantDigits, 'UP');
    quantity += assets.baseAsset.stepSize; //in case rounding brought it slightly down
    if (quantity < assets.baseAsset.minQty)
        quantity = assets.baseAsset.minQty;
    if (quantity > assets.baseAsset.maxQty)
        quantity = assets.baseAsset.maxQty;
    let totalCost = quantity * price;
    if (totalCost)
        if (isAffordable(side, totalCost)) {
            return quantity;
        }
        else {
            return 0;
        }
}
function isAffordable(side, cost) {
    switch (side) {
        case 'BUY':
            if (cost > assets.quoteAsset.balance)
                return false;
            break;
        case 'SELL':
            if (cost > assets.baseAsset.balance)
                return false;
            break;
    }
    return true;
}
function enterPositions() {
    //TODO: possible to set buy order with stop loss, then close it ourself after certain pips
    let quantity;
    let significantDigits = assets.quoteAsset.tickSize.toString().split('.')[1]
        .length;
    let priceBuy = toPrecision(quantile.lower, significantDigits, 'DOWN');
    let priceSell = toPrecision(quantile.upper, significantDigits, 'UP');
    let takeProfitBuyOrder = toPrecision(priceBuy + assets.quoteAsset.takeProfitPips, significantDigits, 'UP');
    let takeProfitSellOrder = toPrecision(priceSell - assets.quoteAsset.takeProfitPips, significantDigits, 'DOWN');
    let entryType = findpositionsToExit(takeProfitBuyOrder, takeProfitSellOrder);
    quantity = getEntryQuantity('BUY', priceBuy);
    if (entryType.buy &&
        quantity > 0 &&
        priceBuy >= assets.quoteAsset.minPrice) {
        client.order({
            symbol: tradingSymbol,
            side: 'BUY',
            quantity: quantity.toString(),
            price: priceBuy.toString(),
            stopPrice: takeProfitBuyOrder.toString(),
            type: 'TAKE_PROFIT_LIMIT',
            timeInForce: 'GTC',
            newOrderRespType: 'ACK',
        });
    }
    quantity = getEntryQuantity('SELL', priceSell);
    if (entryType.sell &&
        quantity > 0 &&
        priceSell >= assets.quoteAsset.minPrice) {
        client.order({
            symbol: tradingSymbol,
            side: 'SELL',
            quantity: quantity.toString(),
            price: priceSell.toString(),
            stopPrice: takeProfitSellOrder.toString(),
            type: 'TAKE_PROFIT_LIMIT',
            timeInForce: 'GTC',
            newOrderRespType: 'ACK',
        });
    }
}
function getUnenteredPositions() {
    let toExit = [];
    for (let i = 0, size = orders.length; i < size; i++) {
        if (orders[i].orderStatus == 'NEW')
            toExit.push(orders[i]);
    }
    return toExit;
}
async function exitUnenteredPositions(orderId) {
    let toExit = getUnenteredPositions(); //we store here - because the orders array will be changing through webhooks as we cancel
    for (let i = 0, size = toExit.length; i < size; i++) {
        if (orderId !== null && toExit[i].orderId != orderId)
            continue;
        client.cancelOrder({
            symbol: tradingSymbol,
            orderId: toExit[i].orderId,
        });
    }
}
function listenMarket() {
    client.ws.aggTrades([tradingSymbol], (trade) => {
        addPriceToTicker(trade.price);
        calcStandardDev();
        calcQuantile();
        if (findEntry) {
            enterPositions();
        }
        else {
            exitUnenteredPositions(null); //exit all unentered positions
        }
    });
}
async function listenAccount() {
    client.ws.user((msg) => {
        switch (msg.eventType) {
            case 'account':
                assets.baseAsset.balance = Number(msg.balances[assets.baseAsset.name].available);
                assets.quoteAsset.balance = Number(msg.balances[assets.quoteAsset.name].available);
                break;
            case 'executionReport':
                if (msg.symbol != tradingSymbol)
                    return; //not for us
                let order = {
                    orderId: Number(msg.orderId),
                    orderStatus: msg.orderStatus,
                    orderPrice: Number(msg.price),
                    orderStopPrice: Number(msg.stopPrice),
                    orderSide: msg.side,
                };
                let i = orders.findIndex((x) => x.orderId == msg.orderId);
                if (i == -1) {
                    orders.push(order);
                }
                else {
                    orders[i] = order;
                }
                console.log(orders);
                trimOrders();
                break;
        }
    });
}
async function getOpenOrders() {
    let openOrders = await client.openOrders({ symbol: tradingSymbol });
    for (let i = 0, size = openOrders.length; i < size; i++) {
        if (openOrders[i].status == 'NEW') {
            orders.push({
                orderId: Number(openOrders[i].orderId),
                orderStatus: openOrders[i].status,
                orderPrice: Number(openOrders[i].price),
                orderStopPrice: Number(openOrders[i].stopPrice),
                orderSide: openOrders[i].side,
            });
        }
    }
}
function trimOrders() {
    //remove order statuses we don't need to monitor
    for (let i = 0, size = orders.length; i < size; i++) {
        if (orders[i].orderStatus != 'NEW')
            orders.splice(i, 1);
    }
}
start();
//# sourceMappingURL=index.js.map