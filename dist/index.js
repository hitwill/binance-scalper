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
let spendFractionPerTrade = 0.3; //when higher, less pips are  needed to make a profit. Keep uner 0.5
let minTakeProfitTicks = 2; //force target price to move by x ticks at least. (sometimes it's small depending on volume)
//end config
let priceTicker = []; //hold a list of recent prices
let quantile = { upper: Infinity, lower: 0 };
let findEntry = false;
let orders = [];
let currentFee = { maker: Infinity, taker: Infinity };
let assets = {
    minNotional: Infinity,
    quoteAsset: {
        name: process.env.QUOTE_ASSET,
        precision: 0,
        minPrice: Infinity,
        maxPrice: 0,
        tickSize: 0,
        takeProfitPips: 0,
        balance: null,
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
                minTakeProfitTicks =
                    minTakeProfitTicks * assets.quoteAsset.tickSize;
                break;
            case 'MIN_NOTIONAL':
                assets.minNotional = Number(filter.minNotional);
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
        calcQuantile(newTicker);
        if (tickerLength < minTickerLength)
            continue;
        if (!isEvenlyDistributed(newTicker))
            continue; //needs to be distributed around mean **over time**
        standardDeviation = mathjs_1.std(newTicker, 'biased');
        //Get the sell price we would use if we entered the market
        let entryQuantity = getEntryQuantity('BUY', quantile.lower);
        let sellPrice = calcLiquidationPrice(entryQuantity, quantile.lower, 'BUY');
        //multiply deviate by 2 because it's one end, middle, then other end
        if (standardDeviation * 2 >= sellPrice - quantile.lower) {
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
function calcQuantile(ticker) {
    //make sure quantiles are above/ below current price
    quantile.lower = Math.min(toPrecision(mathjs_1.quantileSeq(ticker, 0.01), assets.quoteAsset.precision, 'DOWN'), toPrecision(priceTicker[0] - assets.quoteAsset.tickSize, assets.quoteAsset.tickSize.toString().split('.')[1].length, 'DOWN'));
    quantile.upper = Math.max(toPrecision(mathjs_1.quantileSeq(ticker, 0.99), assets.quoteAsset.precision, 'UP'), toPrecision(priceTicker[0] + assets.quoteAsset.tickSize, assets.quoteAsset.tickSize.toString().split('.')[1].length, 'UP'));
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
    //now we have a clean number - we make sure it's trimmed properly
    precise = Number(precise.toFixed(digits)); //needed to prevent something like 0.1 + 0.2 in js
    return precise;
}
function calcLiquidationPrice(tradeVolume, entryPrice, side) {
    //formula below comes from: profit = volumeSell*exitPrice*fee - volumeBuy*priceBuy (volumeSell has buy fee incorporated)
    let roundType;
    let multiplier;
    if (side == 'SELL') {
        roundType = 'DOWN';
        multiplier = -1;
    }
    else {
        roundType = 'UP';
        multiplier = 1;
    }
    let volumePrice = tradeVolume * entryPrice;
    let profit = multiplier * assets.quoteAsset.takeProfitPips;
    let afterFee = 100 / (100 - currentFee.maker);
    let exitPrice = ((profit + volumePrice) * Math.pow(afterFee, 2)) / tradeVolume;
    if (side == 'SELL') {
        exitPrice = Math.min(entryPrice - minTakeProfitTicks, exitPrice);
    }
    else {
        exitPrice = Math.max(entryPrice + minTakeProfitTicks, exitPrice);
    }
    exitPrice = toPrecision(exitPrice, assets.quoteAsset.tickSize.toString().split('.')[1].length, roundType); //set precission and round it up
    return exitPrice;
}
function calcTakeProfitPips() {
    let minProfit = Number('0.' + String().padEnd(assets.quoteAsset.precision - 1, '0') + 1); //our takeProfit is just the mininimum profit we can get (scalping)
    return minProfit; //we can add rules to increase profit later
}
function findpositionsToExit(orderIdBuy, orderIdSell, priceBuy, priceSell) {
    //exit orders that are disimilar to next ones we'll make
    let entryType = { buy: true, sell: true };
    let toExit = getUnenteredPositions(); //we store here - because the orders array will be changing through webhooks as we cancel
    for (let i = 0, size = orders.length; i < size; i++) {
        switch (orders[i].orderSide) {
            case 'BUY':
                if (orders[i].orderPrice != priceBuy ||
                    orders[i].clientOrderID != orderIdBuy) {
                    exitUnenteredPositions(orders[i].clientOrderID, toExit);
                }
                else {
                    entryType.buy = false;
                }
                break;
            case 'SELL':
                if (orders[i].orderPrice != priceSell ||
                    orders[i].clientOrderID != orderIdSell) {
                    exitUnenteredPositions(orders[i].clientOrderID, toExit);
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
    //price BTC/ETH
    switch (side) {
        case 'BUY':
            quantity =
                (assets.quoteAsset.balance * spendFractionPerTrade) / price;
            quantity = formatQuantity(quantity, price);
            if (quantity * price > assets.quoteAsset.balance)
                return 0;
            break;
        case 'SELL':
            quantity = assets.baseAsset.balance * spendFractionPerTrade;
            quantity = formatQuantity(quantity, price);
            if (quantity > assets.baseAsset.balance)
                return 0;
            break;
    }
    return quantity;
}
function formatQuantity(quantity, price) {
    let significantDigits;
    if (quantity * price < assets.minNotional)
        quantity = assets.minNotional / price + assets.quoteAsset.tickSize;
    if (quantity < assets.baseAsset.minQty)
        quantity = assets.baseAsset.minQty;
    if (quantity > assets.baseAsset.maxQty)
        quantity = assets.baseAsset.maxQty;
    significantDigits = assets.baseAsset.stepSize.toString().split('.')[1]
        .length;
    quantity = toPrecision(quantity, significantDigits, 'UP'); //round up - less likely to  hit max quantity
    return quantity;
}
function randomString() {
    return (+new Date()).toString(36);
}
function enterPositions() {
    let quantityBuy;
    let quantitySell;
    let significantDigits = assets.quoteAsset.tickSize.toString().split('.')[1]
        .length;
    let priceBuy = toPrecision(quantile.lower, significantDigits, 'DOWN');
    let priceSell = toPrecision(quantile.upper, significantDigits, 'UP');
    quantityBuy = getEntryQuantity('BUY', priceBuy);
    quantitySell = getEntryQuantity('SELL', priceSell);
    let takeProfitBuyOrder = calcLiquidationPrice(quantityBuy, priceBuy, 'BUY');
    let takeProfitSellOrder = calcLiquidationPrice(quantitySell, priceSell, 'SELL');
    //Need to tag B/S 'cause exit positions can be same. Avoid using duplicate order id
    let orderIdBuy = randomString() + 'B-' + takeProfitBuyOrder.toString().replace('.', 'x');
    let orderIdSell = randomString() + 'S-' + takeProfitSellOrder.toString().replace('.', 'x');
    let entryType = findpositionsToExit(orderIdBuy, orderIdSell, priceBuy, priceSell);
    if (entryType.buy &&
        quantityBuy > 0 &&
        priceBuy >= assets.quoteAsset.minPrice &&
        priceBuy < priceTicker[0]) {
        doOrder(orderIdBuy, tradingSymbol, 'BUY', quantityBuy, priceBuy);
    }
    if (entryType.sell &&
        quantitySell > 0 &&
        priceSell >= assets.quoteAsset.minPrice &&
        priceSell > priceTicker[0]) {
        doOrder(orderIdSell, tradingSymbol, 'SELL', quantitySell, priceSell);
    }
    function doOrder(orderId, symbol, side, quantity, price) {
        let orderParams = {
            newClientOrderId: orderId,
            symbol: symbol,
            side: side,
            quantity: quantity.toString(),
            price: price.toString(),
            stopPrice: price.toString(),
            type: '',
            timeInForce: 'FOK',
            newOrderRespType: 'ACK',
        };
        console.log(orderParams.newClientOrderId +
            ' ' +
            side +
            ' at: ' +
            orderParams.price);
        if (side == 'BUY') {
            orderParams.type = 'TAKE_PROFIT_LIMIT';
        }
        else {
            orderParams.type = 'TAKE_PROFIT_LIMIT'; //'STOP_LOSS_LIMIT';
        }
        client.order(orderParams).catch((error) => {
            console.log('ERROR:' +
                orderParams.newClientOrderId +
                ' ' +
                orderParams.side +
                ' at: ' +
                orderParams.price);
            console.log(error);
        });
    }
}
function getUnenteredPositions() {
    let toExit = [];
    for (let i = 0, size = orders.length; i < size; i++) {
        if (orders[i].orderStatus == 'NEW') {
            toExit.push(orders[i]);
            orders[i].orderStatus = 'PENDING_CANCEL'; //mark for deletion
        }
    }
    trimOrders(); //remove all those pending cancel
    return toExit;
}
async function exitUnenteredPositions(clientOrderID, toExit) {
    for (let i = 0, size = toExit.length; i < size; i++) {
        if (clientOrderID !== null && toExit[i].clientOrderID != clientOrderID)
            continue;
        let orderParams = {
            symbol: tradingSymbol,
            orderId: toExit[i].orderId,
        };
        console.log('Cancel:' + toExit[i].clientOrderID + ' ' + toExit[i].orderSide + ' at: ' + toExit[i].orderStopPrice);
        client.cancelOrder(orderParams).catch((error) => {
            console.log(orderParams);
            console.log(error);
        });
    }
}
function listenMarket() {
    client.ws.aggTrades([tradingSymbol], (trade) => {
        console.log(Number(trade.price));
        addPriceToTicker(trade.price);
        calcStandardDev();
        if (findEntry) {
            enterPositions();
        }
        else {
            let toExit = getUnenteredPositions(); //we store here - because the orders array will be changing through webhooks as we cancel
            exitUnenteredPositions(null, toExit); //exit all unentered positions
        }
    });
}
//todo: make limit orders fok so that you can do single take profits
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
                if (msg.orderType == 'LIMIT' &&
                    [
                        'FILLED',
                        'PARTIALLY_FILLED',
                    ].indexOf(msg.orderStatus) != -1)
                    liquidateOrder(msg);
                let order = {
                    clientOrderID: msg.newClientOrderId,
                    orderId: msg.orderId,
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
                clientOrderID: openOrders[i].clientOrderId,
                orderId: openOrders[i].orderId,
                orderStatus: openOrders[i].status,
                orderPrice: Number(openOrders[i].price),
                orderStopPrice: Number(openOrders[i].stopPrice),
                orderSide: openOrders[i].side,
            });
        }
    }
}
async function liquidateOrder(order) {
    let price = order.originalClientOrderId.split('-')[1].replace('x', '.'); //convert id back to price
    let quantity = formatQuantity(order.quantity * (100 - currentFee.maker), //less fees
    price);
    let orderParams = {
        symbol: tradingSymbol,
        side: order.side == 'BUY' ? 'SELL' : 'BUY',
        quantity: quantity.toString(),
        price: price,
        stopPrice: price,
        type: '',
        timeInForce: 'GTC',
        newOrderRespType: 'ACK',
    };
    console.log('liquidate:' + orderParams);
    if (orderParams.side == 'BUY') {
        orderParams.type = 'TAKE_PROFIT_LIMIT';
    }
    else {
        orderParams.type = 'TAKE_PROFIT_LIMIT';
    }
    client.order(orderParams).catch((error) => {
        console.log(orderParams);
        console.log(error);
    });
}
function trimOrders() {
    let monitored = [];
    //remove order statuses we don't need to monitor
    for (let i = 0, size = orders.length; i < size; i++) {
        switch (orders[i].orderStatus) {
            case 'NEW':
                monitored.push(orders[i]);
                break;
        }
    }
    orders = monitored;
}
start();
//# sourceMappingURL=index.js.map