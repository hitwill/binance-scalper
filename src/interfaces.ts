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
    };
    baseAsset: { name: string; precision: number; minQty: number ; maxQty: number; stepSize: number };
}