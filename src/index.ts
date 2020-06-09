import { std, quantileSeq, mean } from 'mathjs';
import * as dotenv from 'dotenv';
import Binance from 'binance-api-node';

dotenv.config();
const client = Binance({
    apiKey: process.env.API_KEY,
    apiSecret: process.env.API_SECRET,
});

//config vars
let channelLengthMultiple: number = 2; //multiple of standard dev long channel
let spendFractionPerTrade: number = 0.3; //when higher, less pips are  needed to make a profit. Keep uner 0.5
//end config

let priceTicker: number[] = []; //hold a list of recent prices
let quantile: quantile = { upper: Infinity, lower: 0 };
let findEntry: boolean = false;
let orders: order[] = [];

let currentFee: fee = { maker: Infinity, taker: Infinity };
let assets: assets = {
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

let tradingSymbol: string = assets.baseAsset.name + assets.quoteAsset.name;

async function start() {
    Promise.all([
        getExchangeInfo(), //populate variables
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
        if (
            assets.baseAsset.balance !== null &&
            assets.quoteAsset.balance !== null
        )
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

function getSymbol(exchangeInfo: import('binance-api-node').ExchangeInfo) {
    let symbol: any;
    for (let i = 0, size = exchangeInfo.symbols.length; i < size; i++) {
        symbol = exchangeInfo.symbols[i];
        if (symbol.symbol == tradingSymbol) break;
    }
    return symbol;
}

function extractFees(fees: any[]) {
    for (let i = 0, size = fees.length; i < size; i++) {
        let fee = fees[i];
        if (fee.symbol == tradingSymbol) {
            currentFee.maker = fee.maker;
            currentFee.taker = fee.taker;
            break;
        }
    }
}

function extractRules(symbol: {
    baseAssetPrecision: number;
    quoteAssetPrecision: number;
    filters: string | any[];
}) {
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
                assets.minNotional = Number(filter.minNotional);
                break;
        }
    }
}

function addPriceToTicker(price) {
    priceTicker.unshift(Number(price));
}

function calcStandardDev() {
    let standardDeviation: number = 0;
    let minTickerLength: number = 3;
    let finalTickerLength: number = Infinity;
    let newTicker: number[] = []; // we'll resize the ticker to fit the standard dev we can trade in
    for (
        let tickerLength = 1, size = priceTicker.length;
        tickerLength <= size;
        tickerLength++
    ) {
        findEntry = false;
        newTicker.push(priceTicker[tickerLength - 1]);
        calcQuantile(newTicker);
        if (tickerLength < minTickerLength) continue;
        if (!isEvenlyDistributed(newTicker)) continue; //needs to be distributed around mean **over time**

        standardDeviation = std(newTicker, 'biased');

        //Get the sell price we would use if we entered the market
        let entryQuantity = getEntryQuantity(
            'BUY' as orderSide,
            quantile.lower
        );

        let sellPrice = calcLiquidationPrice(
            entryQuantity,
            quantile.lower,
            'BUY' as orderSide
        );

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

function isEvenlyDistributed(ticker: number[]): boolean {
    //points can not go up in one straight gradient, but
    let average: number = mean(ticker);
    let normalized: number;
    let wasPositive: boolean | null = null;
    let switched: number = 0; //number of times values crossed the average
    let dataPoints: number = ticker.length;

    for (let i = 0; i < dataPoints; i++) {
        let isPositive: boolean | null = null;
        normalized = ticker[i] - average; // make average 'zero point'
        if (normalized > 0) isPositive = true;
        if (normalized < 0) isPositive = false;

        if (isPositive !== wasPositive) switched++;
        wasPositive = isPositive;
    }

    if (switched / dataPoints >= 0.4) {
        return true;
    } else {
        return false;
    }
}

function calcQuantile(ticker: number[]) {
    //make sure quantiles are above/ below current price
    quantile.lower = Math.min(
        toPrecision(
            quantileSeq(ticker, 0.01) as number,
            assets.quoteAsset.precision,
            'DOWN' as roundType
        ),
        toPrecision(
            priceTicker[0] - assets.quoteAsset.tickSize,
            assets.quoteAsset.tickSize.toString().split('.')[1].length,
            'DOWN' as roundType
        )
    );

    quantile.upper = Math.max(
        toPrecision(
            quantileSeq(ticker, 0.99) as number,
            assets.quoteAsset.precision,
            'UP' as roundType
        ),
        toPrecision(
            priceTicker[0] + assets.quoteAsset.tickSize,
            assets.quoteAsset.tickSize.toString().split('.')[1].length,
            'UP' as roundType
        )
    );
}

function toPrecision(num: number, digits: number, roundType: roundType) {
    let precise: number;
    let str = String(num);
    let tail: number;
    let lastDigit = str.indexOf('.') + digits + 1;
    tail = Number(str.slice(lastDigit, lastDigit + 1));
    switch (roundType) {
        case 'UP' as roundType:
            if (tail > 0) {
                precise =
                    Number(str.slice(0, lastDigit)) +
                    Number('0.'.padEnd(digits + 1, '0') + '1');
            } else {
                precise = Number(str.slice(0, lastDigit));
            }
            break;
        case 'DOWN' as roundType:
            precise = Number(str.slice(0, lastDigit));
            break;
        case 'NORMAL' as roundType:
            precise = Number(Number(num).toFixed(digits)); //round as normail

            break;
    }
    //now we have a clean number - we make sure it's trimmed properly
    precise = Number(precise.toFixed(digits)); //needed to prevent something like 0.1 + 0.2 in js
    return precise;
}

function calcLiquidationPrice(
    tradeVolume: number,
    entryPrice: number,
    side: orderSide
) {
    //formula below comes from: profit = volumeSell*priceSell*fee - volumeBuy*priceBuy (volumeSell has buy fee incorporated)
    let roundType: roundType;
    let multiplier: number;
    if (side == ('SELL' as orderSide)) {
        roundType = 'DOWN' as roundType;
        multiplier = -1;
    } else {
        roundType = 'UP' as roundType;
        multiplier = 1;
    }
    let volumePrice = tradeVolume * entryPrice;
    let profit = multiplier * assets.quoteAsset.takeProfitPips;
    let afterFee = 100 / (100 - currentFee.maker);

    let priceSell: number =
        ((profit + volumePrice) * Math.pow(afterFee, 2)) / tradeVolume;

    priceSell = toPrecision(
        priceSell,
        assets.quoteAsset.tickSize.toString().split('.')[1].length,
        roundType
    ); //set precission and round it up

    return priceSell;
}

function calcTakeProfitPips() {
    let minProfit = Number(
        '0.' + String().padEnd(assets.quoteAsset.precision - 1, '0') + 1
    ); //our takeProfit is just the mininimum profit we can get (scalping)
    return minProfit; //we can add rules to increase profit later
}

function findpositionsToExit(
    takeProfitBuyOrder: number,
    takeProfitSellOrder: number
): entryType {
    //exit orders that are disimilar to next ones we'll make
    let entryType: entryType = { buy: true, sell: true };
    for (let i = 0, size = orders.length; i < size; i++) {
        switch (orders[i].orderSide) {
            case 'BUY' as orderSide:
                if (
                    orders[i].orderPrice != quantile.lower ||
                    orders[i].orderStopPrice != takeProfitBuyOrder
                ) {
                    exitUnenteredPositions(orders[i].orderId);
                } else {
                    entryType.buy = false;
                }
                break;
            case 'SELL' as orderSide:
                if (
                    orders[i].orderPrice != quantile.upper ||
                    orders[i].orderStopPrice != takeProfitSellOrder
                ) {
                    exitUnenteredPositions(orders[i].orderId);
                } else {
                    entryType.sell = false;
                }
                break;
        }
    }
    return entryType;
}

function getEntryQuantity(side: orderSide, price: number): number {
    //cross reference api with these rules: https://www.binance.com/en/trade-rule
    let quantity: number = 0;
    //price BTC/ETH
    switch (side) {
        case 'BUY' as orderSide:
            quantity =
                (assets.quoteAsset.balance * spendFractionPerTrade) / price;
            quantity = formatQuantity(quantity, price);
            if (quantity * price > assets.quoteAsset.balance) return 0;
            break;
        case 'SELL' as orderSide:
            quantity = assets.baseAsset.balance * spendFractionPerTrade;
            quantity = formatQuantity(quantity, price);
            if (quantity > assets.baseAsset.balance) return 0;
            break;
    }

    return quantity;
}

function formatQuantity(quantity: number, price: number) {
    let significantDigits: number;
    if (quantity * price < assets.minNotional)
        quantity = assets.minNotional / price + assets.quoteAsset.tickSize;
    if (quantity < assets.baseAsset.minQty) quantity = assets.baseAsset.minQty;
    if (quantity > assets.baseAsset.maxQty) quantity = assets.baseAsset.maxQty;
    significantDigits = assets.baseAsset.stepSize.toString().split('.')[1]
        .length;

    quantity = toPrecision(quantity, significantDigits, 'UP' as roundType); //round up - less likely to  hit max quantity

    return quantity;
}

function enterPositions() {
    let quantityBuy: number;
    let quantitySell: number;

    let significantDigits = assets.quoteAsset.tickSize.toString().split('.')[1]
        .length;
    let priceBuy = toPrecision(
        quantile.lower,
        significantDigits,
        'DOWN' as roundType
    );
    let priceSell = toPrecision(
        quantile.upper,
        significantDigits,
        'UP' as roundType
    );

    quantityBuy = getEntryQuantity('BUY' as orderSide, priceBuy);
    quantitySell = getEntryQuantity('SELL' as orderSide, priceSell);

    let takeProfitBuyOrder: number = calcLiquidationPrice(
        quantityBuy,
        priceBuy,
        'BUY' as orderSide
    );

    let takeProfitSellOrder: number = calcLiquidationPrice(
        quantitySell,
        priceSell,
        'SELL' as orderSide
    );

    let entryType: entryType = findpositionsToExit(
        takeProfitBuyOrder,
        takeProfitSellOrder
    );

    if (
        entryType.buy &&
        quantityBuy > 0 &&
        priceBuy >= assets.quoteAsset.minPrice
    ) {
        doOrder(
            takeProfitBuyOrder.toString().replace('.', 'x'),
            tradingSymbol,
            'BUY' as orderSide,
            quantityBuy,
            priceBuy
        );
    }

    if (
        entryType.sell &&
        quantitySell > 0 &&
        priceSell >= assets.quoteAsset.minPrice
    ) {
        doOrder(
            takeProfitSellOrder.toString().replace('.', 'x'),
            tradingSymbol,
            'SELL' as orderSide,
            quantitySell,
            priceSell
        );
    }

    function doOrder(
        orderId: string,
        symbol: string,
        side: any,
        quantity: number,
        price: number
    ) {
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
        console.log(orderParams);
        if (side == ('BUY' as orderSide)) {
            orderParams.type = 'TAKE_PROFIT_LIMIT';
        } else {
            orderParams.type = 'STOP_LOSS_LIMIT';
        }
        client.order(orderParams as any).catch((error) => {
            console.log(orderParams);
            console.log(error);
        });
    }
}

function getUnenteredPositions() {
    let toExit: order[] = [];
    for (let i = 0, size = orders.length; i < size; i++) {
        if (orders[i].orderStatus == ('NEW' as orderStatus))
            toExit.push(orders[i]);
    }
    return toExit;
}

async function exitUnenteredPositions(orderId: number) {
    let toExit = getUnenteredPositions(); //we store here - because the orders array will be changing through webhooks as we cancel
    for (let i = 0, size = toExit.length; i < size; i++) {
        if (orderId !== null && toExit[i].orderId != orderId) continue;
        client.cancelOrder({
            symbol: tradingSymbol,
            orderId: toExit[i].orderId,
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
        } else {
            exitUnenteredPositions(null); //exit all unentered positions
        }
    });
}
//todo: make limit orders fok so that you can do single take profits
async function listenAccount() {
    client.ws.user((msg: any) => {
        switch (msg.eventType) {
            case 'account':
                assets.baseAsset.balance = Number(
                    msg.balances[assets.baseAsset.name].available
                );
                assets.quoteAsset.balance = Number(
                    msg.balances[assets.quoteAsset.name].available
                );
                break;
            case 'executionReport':
                if (msg.symbol != tradingSymbol) return; //not for us
                if (
                    msg.orderType == ('LIMIT' as orderType) &&
                    [
                        'FILLED' as orderStatus,
                        'PARTIALLY_FILLED' as orderStatus,
                    ].indexOf(msg.orderStatus as orderStatus) != -1
                )
                    liquidateOrder(msg);
                let order: order = {
                    orderId: Number(msg.orderId),
                    orderStatus: msg.orderStatus,
                    orderPrice: Number(msg.price),
                    orderStopPrice: Number(msg.stopPrice),
                    orderSide: msg.side as orderSide,
                };

                let i = orders.findIndex((x) => x.orderId == msg.orderId);
                if (i == -1) {
                    orders.push(order);
                } else {
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
        if ((openOrders[i].status as orderStatus) == ('NEW' as orderStatus)) {
            orders.push({
                orderId: Number(openOrders[i].orderId),
                orderStatus: openOrders[i].status as orderStatus,
                orderPrice: Number(openOrders[i].price),
                orderStopPrice: Number(openOrders[i].stopPrice),
                orderSide: openOrders[i].side as orderSide,
            });
        }
    }
}

async function liquidateOrder(order) {
    let price = order.originalClientOrderId.replace('x', '.'); //convert id back to price
    let quantity = formatQuantity(
        order.quantity * (100 - currentFee.maker), //less fees
        price
    );

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
    if (orderParams.side == ('BUY' as orderSide)) {
        orderParams.type = 'TAKE_PROFIT_LIMIT';
    } else {
        orderParams.type = 'STOP_LOSS_LIMIT';
    }

    client.order(orderParams as any).catch((error) => {
        console.log(orderParams);
        console.log(error);
    });
}

function trimOrders() {
    let monitored: order[] = [];
    //remove order statuses we don't need to monitor
    for (let i = 0, size = orders.length; i < size; i++) {
        switch (orders[i].orderStatus) {
            case 'NEW' as orderStatus:
                monitored.push(orders[i]);
                break;
        }
    }
    orders = monitored;
}

start();
