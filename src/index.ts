import { std } from 'mathjs';
import * as dotenv from 'dotenv';
import Binance from 'binance-api-node';

dotenv.config();
const client = Binance({
    apiKey: process.env.API_KEY,
    apiSecret: process.env.API_SECRET,
});

let priceTicker: number[] = []; //hold a list of recent prices
let standardDeviation: number = 0;
let minTradeableDeviation: number; //getMinTradeableDeviation();
let currentFee: fee = { maker: Infinity, taker: Infinity };
let assets: assets = {
    quoteAsset: {
        name: process.env.QUOTE_ASSET,
        precision: 0,
        minPrice: Infinity,
        maxPrice: 0,
        tickSize: 0,
        takeProfitPips: 0
    },
    baseAsset: {
        name: process.env.BASE_ASSET,
        precision: 0,
        minQty: Infinity,
        maxQty: 0,
        stepSize: 0,
    },
};

let tradingSymbol: string = assets.baseAsset.name + assets.quoteAsset.name;

async function start() {
    await getExchangeInfo(); //populate variables
    assets.quoteAsset.takeProfitPips = getTakeProfitPips();
    //listenMarket(); //start listening
}

async function getExchangeInfo() {
    let exchangeInfo = await client.exchangeInfo();
    let fees = await client.tradeFee();
    let symbol = getSymbol(exchangeInfo);
    extractFees(fees.tradeFee);
    extractRules(symbol);
}

function getSymbol(exchangeInfo: import("binance-api-node").ExchangeInfo) {
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

function extractRules(symbol: { baseAssetPrecision: number; quoteAssetPrecision: number; filters: string | any[]; }) {
    assets.baseAsset.precision = symbol.baseAssetPrecision;
    assets.quoteAsset.precision = symbol.quoteAssetPrecision;

    for (let i = 0, size = symbol.filters.length; i < size; i++) {
        let filter = symbol.filters[i];
        switch (filter.filterType) {
            case 'LOT_SIZE':
                assets.baseAsset.minQty = filter.minQty;
                assets.baseAsset.maxQty = filter.maxQty;
                assets.baseAsset.stepSize = filter.stepSize;
                break;
            case 'PRICE_FILTER':
                assets.quoteAsset.minPrice = filter.minPrice;
                assets.quoteAsset.maxPrice = filter.maxPrice;
                assets.quoteAsset.tickSize = filter.tickSize;
                break;
        }
    }
}

function addPriceToTicker(price) {
    priceTicker.unshift(price);
}

function calcStandardDev() {
    let newTicker = []; // we'll resize the ticker to fit the standard dev we can trade in
    for (let i = 0, size = priceTicker.length; i < size; i++) {
        newTicker.push(priceTicker[i]);
        standardDeviation = std(priceTicker);
        if (standardDeviation > minTradeableDeviation) break; //ticker is long enought
        if (standardDeviation >= assets.quoteAsset.takeProfitPips) break; //ticker is long enought
    }
    priceTicker = newTicker; // resize the ticker
}

function toPrecision(num: number, digits: number, roundUpwards: boolean) {
    let precise: number;
    
    if (roundUpwards == true) {
        let tail: number;
        let str = String(num);
        let position: number = str.indexOf('.') + digits + 1;
        tail = Number(str.slice(position, position + 1));
        if(tail > 0) {
            precise = Number(str.slice(0, position)) + Number('0.'.padEnd(digits+1,'0')+'1');
        }else{
            precise = Number(str.slice(0, position));
        }
    } else {
        precise = Number(num.toFixed(digits)); //round as normail
    }
    return precise;
}
function getTakeProfitPips() {
    let minProfit = getMinProfitPips(); //our takeProfit is just the mininimum profit we can get (scalping)
    return minProfit; //we can add rules to increase profit later
}
function listenMarket() {
    client.ws.aggTrades([tradingSymbol], (trade) => {
        addPriceToTicker(trade.price);
        calcStandardDev();
        console.log(standardDeviation, priceTicker);
    });
}

start();

//now add price to an array and maintain length with a function <--length can be adjusted later
//calculate standard dev
//calculate price entry (quartile) and exit (min profit)

//https://mathjs.org/docs/reference/functions/std.html
