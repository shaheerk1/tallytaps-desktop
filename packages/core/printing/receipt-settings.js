const { normalizeReceiptLanguage, getReceiptLabels } = require('./receipt-localization.service');

/**
 * What a bill prints, built from two settings groups:
 *
 *   * `general` -- who the store is: name, tagline, address, phone, currency;
 *   * `workstation` -- the receipt extras: header and footer lines, logo, language.
 *
 * Each value has exactly one home. There is deliberately no fallback from one
 * group to the other: an old `workstation.store_address_1` once sat behind the
 * General address, so clearing or changing the address on the settings screen
 * could print a different line than the one the screen showed.
 *
 * Both groups are read for the signed-in location (its own rows, else the
 * shared ones), so the caller must be a signed-in channel -- see
 * settings.service.js.
 */
function resolveReceiptSettings(general = {}, workstation = {}) {
  const asText = (value) => String(value ?? '').trim();
  const nonEmpty = (values) => values.map(asText).filter(Boolean);
  const logo = workstation.receipt_logo && typeof workstation.receipt_logo === 'object' ? workstation.receipt_logo : {};

  const storeName = asText(general.store_name);
  const tagline = asText(general.store_tagline);
  const addressLines = nonEmpty([general.store_address_1, general.store_address_2]);
  const phone = asText(general.store_phone);
  const language = normalizeReceiptLanguage(asText(workstation.receipt_language));
  // A header line that repeats the store's own details would print twice.
  const brandLines = new Set([storeName, tagline, ...addressLines, phone].filter(Boolean).map((line) => line.toLocaleLowerCase()));

  return {
    storeName,
    tagline,
    addressLines,
    phone,
    headers: nonEmpty([workstation.bill_header_1, workstation.bill_header_2, workstation.bill_header_3])
      .filter((line) => !brandLines.has(line.toLocaleLowerCase())),
    footers: nonEmpty([workstation.bill_footer_1, workstation.bill_footer_2]),
    currencySymbol: asText(general.currency_symbol) || 'Rs.',
    dateFormat: asText(general.date_format) || 'Y-m-d',
    logoDataUrl: logo.enabled && typeof logo.dataUrl === 'string' ? logo.dataUrl : '',
    language,
    labels: getReceiptLabels(language)
  };
}

module.exports = { resolveReceiptSettings };
