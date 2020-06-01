interface fee {
    maker: number;
    taker: number;
}

interface quantile {
    upper: number;
    lower: number;
}

interface assets {
    quoteAsset: {
        name: string;
        precision: number;
        minPrice: number;
        maxPrice: number;
        tickSize: number;
        takeProfitPips: number;
        balance: number;
    };
    baseAsset: {
        name: string;
        precision: number;
        minQty: number;
        maxQty: number;
        stepSize: number;
        balance: number;
    };
}

interface order {
    orderId: number;
    orderStatus: orderStatus;
    orderSide: orderSide;
    orderPrice: number;
    orderStopPrice: number;
}


interface entryType {
    buy: boolean;
    sell: boolean;
}