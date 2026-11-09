// The suppliers' price list the example restock agent reads with
// web.fetch: a plain page, one row per supplier and fabric. The test suite
// and the development demo serve it on their own address; the test bench
// has its text, as web.fetch would give it, under SUPPLIERS_URL.

export const SUPPLIERS_URL = "https://suppliers.example/prices";

export const SUPPLIERS = [
  { supplier: "Northmill Textiles", fabric: "Linen, natural", price_usdc: 6.5, delivery_days: 3 },
  { supplier: "Harbor Cloth Co.", fabric: "Linen, natural", price_usdc: 5.9, delivery_days: 9 },
  { supplier: "Weftworks", fabric: "Linen, natural", price_usdc: 6.1, delivery_days: 5 },
  { supplier: "Northmill Textiles", fabric: "Wool felt", price_usdc: 11, delivery_days: 4 },
  { supplier: "Harbor Cloth Co.", fabric: "Wool felt", price_usdc: 9.8, delivery_days: 12 },
  { supplier: "Weftworks", fabric: "Wool felt", price_usdc: 10.5, delivery_days: 6 },
  { supplier: "Northmill Textiles", fabric: "Canvas, heavy", price_usdc: 7.2, delivery_days: 2 },
  { supplier: "Harbor Cloth Co.", fabric: "Canvas, heavy", price_usdc: 6.8, delivery_days: 5 },
  { supplier: "Weftworks", fabric: "Canvas, heavy", price_usdc: 7.5, delivery_days: 3 },
];

export const SUPPLIERS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Supplier prices</title><style>body{font-family:sans-serif}</style></head>
<body>
<h1>Supplier prices</h1>
<p>Prices per metre in USDC, and how many days delivery takes.</p>
<table>
<tr><th>supplier</th><th>fabric</th><th>price_usdc</th><th>delivery_days</th></tr>
${SUPPLIERS.map((s) => `<tr><td>${s.supplier}</td><td>${s.fabric}</td><td>${s.price_usdc.toFixed(2)}</td><td>${s.delivery_days}</td></tr>`).join("\n")}
</table>
</body>
</html>
`;
