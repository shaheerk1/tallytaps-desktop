'use strict';

const DEFAULT_RECEIPT_LANGUAGE = 'en-LK';

const RECEIPT_LABELS = {
  'en-LK': {
    item: 'ITEM', qty: 'QTY', kg: 'KG', rate: 'RATE', amount: 'AMOUNT',
    qtyTotal: 'QTY TOTAL', subtotal: 'Subtotal', bagCharge: 'Bag Charge',
    wageCharge: 'Wage Charge', discount: 'Discount', total: 'TOTAL',
    receipt: 'Receipt', invoice: 'Invoice', date: 'Date', terminal: 'Terminal',
    cashier: 'Cashier', customer: 'Customer', document: 'Document', original: 'Original',
    refund: 'REFUND', refundTotal: 'REFUND TOTAL', cash: 'Cash', card: 'Card', cheque: 'Cheque',
    change: 'Change', pendingBalance: 'Pending Balance', phone: 'Tel',
    salesReport: 'Sales Report', period: 'Period', lines: 'Lines', order: 'Order'
  },
  'si-LK': {
    item: 'වර්ගය', qty: 'මලු', kg: 'කි.ග්‍රෑ.', rate: 'මිල', amount: 'මුදල',
    qtyTotal: 'මලු එකතුව', subtotal: 'උප එකතුව', bagCharge: 'මලු',
    wageCharge: 'කුලිය', discount: 'වට්ටම', total: 'එකතුව',
    receipt: 'බිල', invoice: 'ඉන්වොයිස් අංකය', date: 'දිනය', terminal: 'ටර්මිනලය',
    cashier: 'කැෂියර්', customer: 'පාරිභෝගිකයා', document: 'ලේඛනය', original: 'මුල්',
    refund: 'ආපසු ගෙවීම', refundTotal: 'ආපසු ගෙවීමේ එකතුව', cash: 'මුදල්', card: 'කාඩ්පත', cheque: 'චෙක්පත',
    change: 'ඉතිරි මුදල', pendingBalance: 'ගෙවීමට ඇති මුදල', phone: 'දුරකථන',
    salesReport: 'විකුණුම් වාර්තාව', period: 'කාලය', lines: 'පේළි', order: 'අනුපිළිවෙළ'
  },
  'ta-LK': {
    item: 'பொருள்', qty: 'அளவு', kg: 'கி.கி.', rate: 'விலை', amount: 'தொகை',
    qtyTotal: 'மொத்த அளவு', subtotal: 'இடைத் தொகை', bagCharge: 'பை கட்டணம்',
    wageCharge: 'கூலி கட்டணம்', discount: 'தள்ளுபடி', total: 'மொத்தம்',
    receipt: 'பற்றுச்சீட்டு', invoice: 'விலைப்பட்டியல்', date: 'தேதி', terminal: 'முனையம்',
    cashier: 'காசாளர்', customer: 'வாடிக்கையாளர்', document: 'ஆவணம்', original: 'அசல்',
    refund: 'பண மீளளிப்பு', refundTotal: 'பண மீளளிப்பு மொத்தம்', cash: 'பணம்', card: 'அட்டை', cheque: 'காசோலை',
    change: 'மீதி', pendingBalance: 'நிலுவைத் தொகை', phone: 'தொலைபேசி',
    salesReport: 'விற்பனை அறிக்கை', period: 'காலம்', lines: 'வரிகள்', order: 'வரிசை'
  }
};

const LANGUAGE_OPTIONS = [
  { code: 'en-LK', label: 'English' },
  { code: 'si-LK', label: 'සිංහල (Sinhala)' },
  { code: 'ta-LK', label: 'தமிழ் (Tamil)' }
];

const LABEL_ALIASES = {
  item: ['ITEM'], qty: ['QTY', 'QUANTITY'], kg: ['KG', 'KILOS'], rate: ['RATE'], amount: ['AMOUNT'],
  qtyTotal: ['QTY TOTAL'], subtotal: ['SUBTOTAL'], bagCharge: ['BAG CHARGE', 'BAG CHARGES'],
  wageCharge: ['WAGE CHARGE', 'WAGE CHARGES'], discount: ['DISCOUNT'], total: ['TOTAL'],
  receipt: ['RECEIPT'], invoice: ['INVOICE'], date: ['DATE'], terminal: ['TERMINAL'], cashier: ['CASHIER'],
  customer: ['CUSTOMER'], document: ['DOCUMENT'], original: ['ORIGINAL'], refund: ['REFUND'],
  refundTotal: ['REFUND TOTAL'], cash: ['CASH'], card: ['CARD'], cheque: ['CHEQUE'], change: ['CHANGE'],
  pendingBalance: ['PENDING BALANCE'], phone: ['TEL', 'PHONE'], salesReport: ['SALES REPORT'],
  period: ['PERIOD'], lines: ['LINES'], order: ['ORDER']
};

function normalizeReceiptLanguage(value) {
  return Object.prototype.hasOwnProperty.call(RECEIPT_LABELS, value) ? value : DEFAULT_RECEIPT_LANGUAGE;
}

function getReceiptLabels(language) {
  return { ...RECEIPT_LABELS[normalizeReceiptLanguage(language)] };
}

function localizeReceiptLabel(value, language) {
  const original = String(value ?? '');
  const normalized = original.trim().toLocaleUpperCase('en-US');
  const chequeReference = original.match(/^\s*CHEQUE(\s*#.*)$/i);
  if (chequeReference) return `${getReceiptLabels(language).cheque}${chequeReference[1]}`;
  const key = Object.keys(LABEL_ALIASES).find((candidate) => LABEL_ALIASES[candidate].includes(normalized));
  return key ? getReceiptLabels(language)[key] : original;
}

function localizeReceiptDocument(doc) {
  const language = normalizeReceiptLanguage(doc?.receiptLanguage);
  const translate = (value) => localizeReceiptLabel(value, language);
  return {
    ...(doc || {}),
    receiptLanguage: language,
    meta: (doc?.meta || []).map((entry) => ({
      ...entry,
      label: translate(entry.label),
      value: entry.translateValue ? translate(entry.value) : entry.value
    })),
    totals: (doc?.totals || []).map((entry) => ({ ...entry, label: translate(entry.label) })),
    items: (doc?.items || []).map((item) => ({
      ...item,
      extras: (item.extras || []).map((extra) => ({ ...extra, label: translate(extra.label) }))
    }))
  };
}

module.exports = {
  DEFAULT_RECEIPT_LANGUAGE,
  LANGUAGE_OPTIONS,
  normalizeReceiptLanguage,
  getReceiptLabels,
  localizeReceiptLabel,
  localizeReceiptDocument
};
