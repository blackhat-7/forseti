import {fixture, preserved, observeCases, equal, check, toolChecks, pythonHygieneChanged} from './helpers.mjs';
const original = fixture('order-pricing');
const EDITABLE = Object.keys(original).filter(p => p.endsWith('.py') && !['observe.py', 'check_public.py'].includes(p));

function patch(path, from, to) {
  const text = original[path];
  if (!text.includes(from)) throw new Error(`order-pricing control: ${path} no longer contains the patched text`);
  return text.replace(from, to);
}
// Defect 1, the visible one: cart lines are the cached price entries themselves, and promotions
// lower unit_price in place, so every later order of that tier starts from the discounted price.
const CART = patch('cart.py', '        line = price_list[sku]\n', '        line = dict(price_list[sku])\n');
// Defect 2: the catalog tells listeners which sku changed, and the cache drops the list of a tier
// with that name, which is none of them. New orders keep the old price.
const CACHE = patch('price_cache.py', '        catalog.on_change(self.invalidate)',
  '        # A price change can touch every tier\'s list.\n        catalog.on_change(lambda sku: self.invalidate())');
// Defect 3: a refund reprices from today's tier list instead of the invoice. While defect 1 stands,
// the cached entry holds the discounted price, which hides this for a single promotional order.
const REFUNDS = patch('refunds.py', `        product = self.prices.price_list(order["tier"])[sku]
        net = quantity * product["unit_price"]
        self._refunded[(order_id, sku)] = already + quantity
        return net + line_vat(net, product["category"])`, `        net = quantity * line["unit_price"]
        self._refunded[(order_id, sku)] = already + quantity
        return net + line_vat(net, line["category"])`);

export const reference = {files: {...original, 'cart.py': CART, 'price_cache.py': CACHE, 'refunds.py': REFUNDS},
  answer: 'Copied price entries into cart lines, dropped every tier list on a price change, and refunded at the invoice price.'};
// The symptom plus its most visible cause: check_public.py passes, the two deeper defects remain.
export const baseline = {files: {...original, 'cart.py': CART}, answer: 'Stopped cart lines sharing the cached price entries.'};

const line = (sku, category, qty, free, unit, vat) => ({sku, category, qty, free, unit_price: unit, net: (qty - free) * unit, vat});
function invoice(lines, delivery) {
  const goods_net = lines.reduce((n, l) => n + l.net, 0), vat = lines.reduce((n, l) => n + l.vat, 0);
  return {lines, goods_net, vat, delivery, total: goods_net + vat + delivery};
}
const ok = value => ({value, error: null});
const err = error => ({value: null, error});
const order = (customer, items) => ({op: 'order', customer, items});
const inv = id => ({op: 'invoice', id});
const refund = (id, sku, qty) => ({op: 'refund', id, sku, qty});

/**
 * Worked prices (cents). Trade pays 85% of list, rounded half up; BULBS10 then takes 10% off the
 * unit, rounded half up; VAT is per line, half up: bulbs, seeds, soil 5%, tools 20%.
 *   tulip  1250: trade 1063, trade+promo 957; retail+promo 1125.
 *   daffodil 990: trade 842, trade+promo 758; retail+promo 891.
 *   gloves 1150 -> 1290: trade 978 -> 1097.
 */
const PUBLIC_INVOICE = invoice([line('BLB-TUL', 'bulbs', 2, 0, 957, 96), line('SED-BAS', 'seeds', 3, 0, 276, 41)], 495);

/**
 * Each scenario runs against a fresh shop in its own interpreter. The public check is one trade
 * customer ordering the same thing twice; each scenario reaches something it does not:
 *   repeat     another customer of the same tier and another bulb. Clearing the cache per order
 *              makes this pass and leaves the refund defect exposed.
 *   merge      duplicate cart entries, a multi-buy, free delivery, and a refund of a discounted
 *              line after a later order.
 *   price      a price change, then new orders in two tiers and refunds of orders from before it.
 *              Nothing ever drops a tier list, so the old price sticks; and once it does drop,
 *              a refund that reprices from the list pays the new price for an old sale.
 *   promo-end  refunds after the promotion that discounted them has ended.
 */
const SCENARIOS = {
  repeat: [
    [order('C-200', [['BLB-TUL', 2], ['SED-BAS', 3]]), ok('O-1')],
    [order('C-300', [['BLB-TUL', 2], ['SED-BAS', 3]]), ok('O-2')],
    [inv('O-1'), ok(PUBLIC_INVOICE)],
    [inv('O-2'), ok(PUBLIC_INVOICE)],
    [order('C-200', [['BLB-DAF', 1]]), ok('O-3')],
    [inv('O-3'), ok(invoice([line('BLB-DAF', 'bulbs', 1, 0, 758, 38)], 495))],
  ],
  merge: [
    [order('C-100', [['SL-CMP', 2], ['TL-TRW', 1], ['SL-CMP', 1], ['BLB-TUL', 1], ['BLB-TUL', 1]]), ok('O-1')],
    [inv('O-1'), ok(invoice([line('SL-CMP', 'soil', 3, 1, 845, 85), line('TL-TRW', 'tools', 1, 0, 1899, 380), line('BLB-TUL', 'bulbs', 2, 0, 1125, 113)], 0))],
    [order('C-400', [['BLB-TUL', 2]]), ok('O-2')],
    [inv('O-2'), ok(invoice([line('BLB-TUL', 'bulbs', 2, 0, 1125, 113)], 495))],
    [refund('O-1', 'SL-CMP', 2), ok(1775)],
    [refund('O-1', 'SL-CMP', 1), err('InvalidRefund')],
    [refund('O-1', 'BLB-TUL', 1), ok(1181)],
  ],
  price: [
    [order('C-100', [['TL-GLV', 2]]), ok('O-1')],
    [order('C-300', [['TL-GLV', 1]]), ok('O-2')],
    [{op: 'price', sku: 'TL-GLV', list_price: 1290}, ok(null)],
    [order('C-100', [['TL-GLV', 2]]), ok('O-3')],
    [order('C-300', [['TL-GLV', 1]]), ok('O-4')],
    [inv('O-1'), ok(invoice([line('TL-GLV', 'tools', 2, 0, 1150, 460)], 495))],
    [inv('O-3'), ok(invoice([line('TL-GLV', 'tools', 2, 0, 1290, 516)], 495))],
    [inv('O-4'), ok(invoice([line('TL-GLV', 'tools', 1, 0, 1097, 219)], 495))],
    [refund('O-1', 'TL-GLV', 1), ok(1380)],
    [refund('O-3', 'TL-GLV', 1), ok(1548)],
    [refund('O-2', 'TL-GLV', 1), ok(1174)],
  ],
  'promo-end': [
    [order('C-400', [['BLB-DAF', 3], ['SED-TOM', 2]]), ok('O-1')],
    [{op: 'end', promotion: 'BULBS10'}, ok(null)],
    [order('C-400', [['BLB-DAF', 3]]), ok('O-2')],
    [inv('O-2'), ok(invoice([line('BLB-DAF', 'bulbs', 3, 0, 990, 149)], 495))],
    [refund('O-1', 'BLB-DAF', 2), ok(1871)],
    [refund('O-2', 'BLB-DAF', 1), ok(1040)],
    [refund('O-1', 'BLB-DAF', 2), err('InvalidRefund')],
    [refund('O-1', 'SED-TOM', 2), ok(861)],
    [inv('O-1'), ok(invoice([line('BLB-DAF', 'bulbs', 3, 0, 891, 134), line('SED-TOM', 'seeds', 2, 0, 410, 41)], 495))],
  ],
};

export async function grade({files, python, trace, lane, control, agent}) {
  const hygiene = await pythonHygieneChanged(python, files, original, EDITABLE);
  const runs = {}, got = {};
  for (const [name, steps] of Object.entries(SCENARIOS)) {
    runs[name] = await observeCases(python, steps.map(([step]) => step));
    got[name] = runs[name].value;
  }
  const same = (name, ...indexes) => indexes.every(i => equal('', got[name]?.[i], SCENARIOS[name][i][1]).passed);
  return [
    ...hygiene,
    check('runs', 'correctness', Object.values(runs).every(r => r.ok), Object.entries(runs).filter(([, r]) => !r.ok).map(([n, r]) => `${n}: ${r.diagnostic}`).join('\n') || 'every scenario ran'),
    ...Object.entries(SCENARIOS).map(([name, steps]) => equal(`scenario-${name}`, got[name], steps.map(([, expected]) => expected))),
    check('later-orders-keep-their-price', 'correctness', same('repeat', 2, 3, 5) && same('merge', 3),
      'Cart lines were the cached price entries, and the promotion lowered unit_price on them in place, so each later order of the tier was discounted again.'),
    check('ended-promotion-is-not-charged', 'correctness', same('promo-end', 3),
      'After BULBS10 ends a daffodil costs its list price. A shared, already-discounted cache entry keeps charging the promotional price.'),
    check('price-change-reaches-new-orders', 'correctness', same('price', 6, 7),
      'The catalog notifies with the sku and the cache drops the tier of that name, which is none, so new orders keep the old price.'),
    check('refund-pays-the-invoice-price', 'correctness', same('merge', 6) && same('price', 8, 10) && same('promo-end', 4, 5, 7),
      'A refund repriced from the current tier list pays the undiscounted or the new price. It must pay what the invoice charged.'),
    preserved(files, original, EDITABLE),
    ...toolChecks(trace, ['checkout.py', 'cart.py'], 'check_public.py', false, {lane, control, agent}),
  ];
}
