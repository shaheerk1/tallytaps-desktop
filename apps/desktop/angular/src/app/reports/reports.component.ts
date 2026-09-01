import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';
import type { PrintDocument } from '../../../../../../packages/shared/ipc/pos-api';

type SalesRow = { groupLabel: string; txnDate: string; txnTime: string; itemCode: string; description: string; supplierCode: string; customerCode: string; status: string; lineCount: number; invoiceCount: number; quantity: number; kilos: number; unitPrice: number; merchandiseTotal: number; bagChargeTotal: number; wageChargeTotal: number; total: number };
type SalesTotals = { lineCount: number; invoiceCount: number; quantity: number; kilos: number; merchandiseTotal: number; bagChargeTotal: number; wageChargeTotal: number; total: number };
type SalesResult = { rows: SalesRow[]; totals: SalesTotals; groupBy: string; fromDate: string | null; toDate: string | null };
type Column = { key: string; label: string; numeric?: boolean; money?: boolean; selected: boolean };
type SalesItemOption = { itemCode: string; description: string; salesCount: number };

@Component({ selector: 'pos-reports', templateUrl: './reports.component.html', styleUrls: ['./reports.component.css'] })
export class ReportsComponent implements OnInit {
  activeTab: 'sales' | 'operations' = 'sales';
  fromDate = new Date().toISOString().slice(0, 10);
  toDate = this.fromDate;
  groupBy = 'item'; sortBy = 'date'; sortDir: 'desc' | 'asc' = 'desc';
  supplierCode = ''; customerCode = ''; itemTerm = ''; finalizedOnly = true;
  itemOptions: SalesItemOption[] = []; selectedItemCodes: string[] = []; allItemsSelected = true; itemPickerOpen = false; itemPickerSearch = '';
  sales: SalesResult = { rows: [], totals: { lineCount: 0, invoiceCount: 0, quantity: 0, kilos: 0, merchandiseTotal: 0, bagChargeTotal: 0, wageChargeTotal: 0, total: 0 }, groupBy: 'item', fromDate: null, toDate: null };
  suppliers: any[] = []; inventory: any[] = [];
  error = ''; loading = false; info = '';
  columns: Column[] = [
    { key: 'date', label: 'Date', selected: true }, { key: 'time', label: 'Time', selected: false }, { key: 'item', label: 'Item code', selected: true }, { key: 'description', label: 'Description', selected: true },
    { key: 'supplier', label: 'Supplier', selected: true }, { key: 'customer', label: 'Customer', selected: true }, { key: 'status', label: 'Status', selected: false }, { key: 'lines', label: 'Lines', numeric: true, selected: false }, { key: 'invoices', label: 'Bills', numeric: true, selected: false },
    { key: 'quantity', label: 'Qty / bags', numeric: true, selected: true }, { key: 'kilos', label: 'Kilos', numeric: true, selected: true }, { key: 'price', label: 'Average rate', numeric: true, money: true, selected: true },
    { key: 'merchandise', label: 'Merchandise', numeric: true, money: true, selected: true }, { key: 'bag', label: 'Bag charge', numeric: true, money: true, selected: true }, { key: 'wage', label: 'Wage charge', numeric: true, money: true, selected: true }, { key: 'total', label: 'Net total', numeric: true, money: true, selected: true }
  ];

  constructor(private session: SessionService, private printing: PrintingService) {}
  private actor() { return this.session.getActor() || undefined; }
  get selectedColumns(): Column[] { return this.columns.filter((column) => column.selected); }
  get salesFilters(): Record<string, unknown> { return { fromDate: this.fromDate || null, toDate: this.toDate || null, groupBy: this.groupBy, sortBy: this.sortBy, sortDir: this.sortDir, supplierCode: this.supplierCode, customerCode: this.customerCode, itemTerm: this.itemTerm, finalizedOnly: this.finalizedOnly, itemCodes: this.allItemsSelected ? undefined : this.selectedItemCodes, columns: this.selectedColumns.map((column) => column.key) }; }
  get filteredItemOptions(): SalesItemOption[] { const term = this.itemPickerSearch.trim().toLowerCase(); return term ? this.itemOptions.filter((item) => `${item.itemCode} ${item.description}`.toLowerCase().includes(term)) : this.itemOptions; }
  get itemPickerLabel(): string { return this.allItemsSelected ? `All items (${this.itemOptions.length})` : `${this.selectedItemCodes.length} item${this.selectedItemCodes.length === 1 ? '' : 's'} selected`; }
  get totalSupplierDue(): number { return this.suppliers.reduce((sum, row) => sum + Number(row.balance || 0), 0); }
  get totalInventoryMovement(): number { return this.inventory.length; }

  async ngOnInit(): Promise<void> {
    const billingDate = String(this.session.getWorkstationSession()?.billingDate || '').slice(0, 10);
    if (billingDate) this.fromDate = this.toDate = billingDate;
    await this.loadSales();
  }
  async selectTab(tab: 'sales' | 'operations'): Promise<void> { this.activeTab = tab; this.error = ''; this.info = ''; if (tab === 'operations' && !this.suppliers.length && !this.inventory.length) await this.loadOperations(); }

  async loadSales(): Promise<void> {
    if (!window.posApi) return;
    this.loading = true; this.error = ''; this.info = '';
    try {
      await this.loadItemOptions();
      const result = await (window.posApi.reports as any).salesDetail(this.salesFilters, this.actor());
      if (!result.success) throw new Error(result.error || 'Could not load sales report.');
      this.sales = result.data || this.sales;
      this.info = `${this.sales.rows.length} sales lines loaded and arranged by ${this.groupBy}.`;
    } catch (error) { this.error = error instanceof Error ? error.message : 'Could not load sales report.'; }
    finally { this.loading = false; }
  }

  private async loadItemOptions(): Promise<void> {
    if (!window.posApi) return;
    const result = await (window.posApi.reports as any).salesItems({ fromDate: this.fromDate || null, toDate: this.toDate || null, finalizedOnly: this.finalizedOnly }, this.actor());
    if (!result.success) throw new Error(result.error || 'Could not load the sales item picker.');
    this.itemOptions = result.data || [];
    if (!this.allItemsSelected) {
      const available = new Set(this.itemOptions.map((item) => item.itemCode));
      this.selectedItemCodes = this.selectedItemCodes.filter((code) => available.has(code));
    }
  }

  selectAllItems(): void { this.allItemsSelected = true; this.selectedItemCodes = []; }
  clearItems(): void { this.allItemsSelected = false; this.selectedItemCodes = []; }
  isItemSelected(code: string): boolean { return this.allItemsSelected || this.selectedItemCodes.includes(code); }
  toggleItem(code: string, checked: boolean): void {
    if (this.allItemsSelected) this.selectedItemCodes = this.itemOptions.map((item) => item.itemCode);
    this.allItemsSelected = false;
    this.selectedItemCodes = checked ? [...new Set([...this.selectedItemCodes, code])] : this.selectedItemCodes.filter((itemCode) => itemCode !== code);
  }

  async loadOperations(): Promise<void> {
    if (!window.posApi) return;
    this.loading = true; this.error = ''; this.info = '';
    const filters = { fromDate: this.fromDate || null, toDate: this.toDate || null };
    try {
      const [supplier, inventory] = await Promise.all([(window.posApi.reports as any).supplierSummary(filters, this.actor()), (window.posApi.reports as any).inventorySummary(filters, this.actor())]);
      if (!supplier.success || !inventory.success) throw new Error(supplier.error || inventory.error || 'Could not load operations reports.');
      this.suppliers = supplier.data || []; this.inventory = inventory.data || []; this.info = `Showing ledger activity from ${this.fromDate} to ${this.toDate}.`;
    } catch (error) { this.error = error instanceof Error ? error.message : 'Could not load operations reports.'; }
    finally { this.loading = false; }
  }

  value(row: SalesRow, key: string): string | number { return (row as unknown as Record<string, string | number>)[this.rowKey(key)] ?? ''; }
  screenColumnLabel(column: Column): string { return ({ quantity: 'Unit Count', kilos: 'Measured Qty', bag: 'Packaging charge' } as Record<string, string>)[column.key] || column.label; }
  total(key: string): number | null { const totalKey: Record<string, keyof SalesTotals> = { lines: 'lineCount', invoices: 'invoiceCount', quantity: 'quantity', kilos: 'kilos', merchandise: 'merchandiseTotal', bag: 'bagChargeTotal', wage: 'wageChargeTotal', total: 'total' }; return totalKey[key] ? Number(this.sales.totals[totalKey[key]] || 0) : null; }
  private rowKey(key: string): string { return ({ date: 'txnDate', time: 'txnTime', item: 'itemCode', description: 'description', supplier: 'supplierCode', customer: 'customerCode', status: 'status', lines: 'lineCount', invoices: 'invoiceCount', quantity: 'quantity', kilos: 'kilos', price: 'unitPrice', merchandise: 'merchandiseTotal', bag: 'bagChargeTotal', wage: 'wageChargeTotal', total: 'total' } as Record<string, string>)[key] || key; }
  format(value: string | number, column: Column): string { if (!column.numeric) return String(value || '-'); const number = Number(value || 0); return column.money ? number.toFixed(2) : (Number.isInteger(number) ? String(number) : number.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')); }

  private salesDocument(): PrintDocument {
    const selectedColumns = this.selectedColumns;
    const numeric = selectedColumns.filter((column) => column.numeric && this.total(column.key) !== null);
    return {
      documentTitle: 'DDEC Sales Report', brand: { name: 'DDEC Sales Report' },
      meta: [{ label: 'Period', value: `${this.fromDate || 'All'} to ${this.toDate || 'All'}` }, { label: 'Group', value: this.groupBy }, { label: 'Sort', value: `${this.sortBy} ${this.sortDir}` }],
      items: this.sales.rows.map((row) => ({
        description: String(row.groupLabel || row.itemCode || 'Sales'),
        qty: [this.selectedColumns.some((column) => column.key === 'quantity') ? `Qty ${this.format(this.value(row, 'quantity'), this.columns.find((column) => column.key === 'quantity')!)}` : '', this.selectedColumns.some((column) => column.key === 'kilos') ? `Kg ${this.format(this.value(row, 'kilos'), this.columns.find((column) => column.key === 'kilos')!)}` : ''].filter(Boolean).join('  '),
        amount: Number(row.total || 0).toFixed(2),
        extras: selectedColumns.filter((column) => !['quantity', 'kilos', 'total'].includes(column.key)).slice(0, 5).map((column) => ({ label: column.label, value: this.format(this.value(row, column.key), column) }))
      })),
      totals: numeric.map((column) => ({ label: `TOTAL ${column.label}`, value: this.format(this.total(column.key) || 0, column), bold: column.key === 'total' }))
    };
  }
  private async salesThermalDocument(): Promise<PrintDocument> {
    let currencySymbol = 'Rs.';
    let receiptLanguage: PrintDocument['receiptLanguage'] = 'en-LK';
    if (window.posApi) {
      const receipt = await window.posApi.settings.getReceipt();
      if (receipt.success && receipt.data?.currencySymbol) {
        currencySymbol = receipt.data.currencySymbol;
        receiptLanguage = receipt.data.language || 'en-LK';
      }
    }
    const currencyPrefix = currencySymbol.endsWith('.') || currencySymbol.endsWith(' ') ? currencySymbol : `${currencySymbol} `;
    const money = (value: number): string => `${currencyPrefix}${Number(value || 0).toFixed(2)}`;
    const measure = (value: number): string => {
      const number = Number(value || 0);
      return Number.isInteger(number) ? String(number) : number.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    };
    return {
      documentTitle: 'DDEC Sales Report',
      brand: { name: 'DDEC Sales Report' },
      meta: [
        { label: 'Period', value: `${this.fromDate || 'All'} to ${this.toDate || 'All'}` },
        { label: 'Lines', value: String(this.sales.rows.length) },
        { label: 'Order', value: `${this.groupBy} / ${this.sortBy} ${this.sortDir}` }
      ],
      itemLayout: 'invoice-measures',
      receiptLanguage,
      quantityTotal: measure(this.sales.totals.quantity),
      items: this.sales.rows.map((row) => ({
        description: `${row.supplierCode ? `${row.supplierCode}~` : ''}${row.itemCode || ''}${row.description ? ` ${row.description}` : ''}`.trim() || 'Sales line',
        qty: `${measure(row.quantity)}${Number(row.kilos || 0) > 0 ? ` qty / ${measure(row.kilos)} kg` : ''} x ${Number(row.unitPrice || 0).toFixed(2)}`,
        amount: money(row.merchandiseTotal),
        measure: {
          qty: measure(row.quantity),
          ...(Number(row.kilos || 0) > 0 ? { kilos: measure(row.kilos) } : {}),
          rate: Number(row.unitPrice || 0).toFixed(2)
        }
      })),
      totals: [
        { label: 'Subtotal', value: money(this.sales.totals.merchandiseTotal) },
        ...(Number(this.sales.totals.bagChargeTotal || 0) > 0 ? [{ label: 'Bag Charges', value: money(this.sales.totals.bagChargeTotal) }] : []),
        ...(Number(this.sales.totals.wageChargeTotal || 0) > 0 ? [{ label: 'Wage Charges', value: money(this.sales.totals.wageChargeTotal) }] : []),
        { label: 'TOTAL', value: money(this.sales.totals.total), bold: true }
      ]
    };
  }
  async printSales(): Promise<void> { const result = await this.printing.printDocument(await this.salesThermalDocument()); if (!result.success) this.error = result.error || 'Print failed.'; else this.info = 'Sales report sent to the thermal printer.'; }
  async saveSalesPdf(): Promise<void> { const result = await this.printing.savePdf(this.salesDocument(), { prompt: true, fileName: `sales-report-${this.toDate || 'all'}.pdf` }); if (!result.success) this.error = result.error || 'PDF export failed.'; else this.info = result.canceled ? 'PDF save canceled.' : `PDF saved to ${result.filePath}.`; }
  async exportSalesXlsx(): Promise<void> { if (!window.posApi) return; const result = await (window.posApi.reports as any).exportSalesXlsx(this.salesFilters, this.actor()); if (!result.success) this.error = result.error || 'Excel export failed.'; else this.info = result.data?.canceled ? 'Excel export canceled.' : `Excel workbook saved to ${result.data?.filePath || 'the selected location'}.`; }
  async printSupplierSummary(): Promise<void> { const result = await this.printing.printDocument(this.supplierDocument()); if (!result.success) this.error = result.error || 'Print failed.'; else this.info = 'Supplier summary sent to the receipt printer.'; }
  private supplierDocument(): PrintDocument { return { brand: { name: 'Supplier Summary' }, meta: [{ label: 'Period', value: `${this.fromDate} to ${this.toDate}` }], items: this.suppliers.map((row) => ({ description: `${row.supplier_code || ''} ${row.name}`, qty: 'Balance', amount: Number(row.balance).toFixed(2) })), totals: [{ label: 'TOTAL DUE', value: this.totalSupplierDue.toFixed(2), bold: true }] }; }
  async saveSupplierPdf(): Promise<void> { const result = await this.printing.savePdf(this.supplierDocument(), { prompt: true, fileName: `supplier-summary-${this.toDate}.pdf` }); if (!result.success) this.error = result.error || 'PDF export failed.'; else this.info = result.canceled ? 'PDF save canceled.' : `A4 PDF saved to ${result.filePath}.`; }
  async exportOperationsXlsx(): Promise<void> { if (!window.posApi) return; const result = await (window.posApi.reports as any).exportDdecXlsx({ fromDate: this.fromDate || null, toDate: this.toDate || null }, this.actor()); if (!result.success) this.error = result.error || 'Excel export failed.'; else this.info = result.data?.canceled ? 'Excel export canceled.' : `Excel workbook saved to ${result.data?.filePath || 'the selected location'}.`; }
}
