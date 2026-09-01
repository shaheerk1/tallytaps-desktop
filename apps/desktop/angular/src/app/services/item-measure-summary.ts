export type ItemMeasureSummary = {
  key: string;
  description: string;
  qty: number;
  kilos: number;
  hasKilos: boolean;
  handlingUom: string;
  baseUom: string;
};

type ItemMeasureSource = {
  productId?: number | string | null;
  product_id?: number | string | null;
  itemCode?: string | null;
  item_code?: string | null;
  description?: string | null;
  qty?: number | string | null;
  quantity?: number | string | null;
  kilos?: number | string | null;
  handlingUom?: string | null;
  baseUom?: string | null;
  handling_uom_snapshot?: string | null;
  base_uom_snapshot?: string | null;
};

function finiteMeasure(value: unknown): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function roundedMeasure(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function summarizeItemMeasures(lines: ItemMeasureSource[] | null | undefined): ItemMeasureSummary[] {
  const grouped = new Map<string, ItemMeasureSummary>();

  for (const line of lines || []) {
    const productId = line.productId ?? line.product_id;
    const itemCode = String(line.itemCode ?? line.item_code ?? '').trim().toUpperCase();
    const description = String(line.description || '').trim() || 'Unnamed item';
    const key = productId !== null && productId !== undefined && String(productId) !== ''
      ? `product:${productId}`
      : itemCode
        ? `code:${itemCode}`
        : `description:${description.toLocaleLowerCase()}`;
    const handlingUom = String(line.handlingUom ?? line.handling_uom_snapshot ?? 'units').trim() || 'units';
    const baseUom = String(line.baseUom ?? line.base_uom_snapshot ?? 'measured units').trim() || 'measured units';
    const existing = grouped.get(key) || { key, description, qty: 0, kilos: 0, hasKilos: false, handlingUom, baseUom };
    existing.qty = roundedMeasure(existing.qty + finiteMeasure(line.qty ?? line.quantity));
    if (line.kilos !== null && line.kilos !== undefined && line.kilos !== '') {
      existing.hasKilos = true;
      existing.kilos = roundedMeasure(existing.kilos + finiteMeasure(line.kilos));
    }
    grouped.set(key, existing);
  }

  return Array.from(grouped.values());
}

export function formatItemMeasure(value: unknown): string {
  const amount = finiteMeasure(value);
  return Number.isInteger(amount)
    ? String(amount)
    : amount.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function itemMeasureSummaryText(summary: ItemMeasureSummary): string {
  const quantity = `${formatItemMeasure(summary.qty)} ${summary.handlingUom}`;
  return summary.hasKilos
    ? `${formatItemMeasure(summary.kilos)} ${summary.baseUom} / ${quantity}`
    : quantity;
}
