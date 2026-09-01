import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { PrintingService } from '../services/printing.service';

@Component({ selector: 'pos-supply-receiving', templateUrl: './supply-receiving.component.html', styleUrls: ['./supply-receiving.component.css'] })
export class SupplyReceivingComponent implements OnInit {
  suppliers: any[] = []; products: any[] = []; receipts: any[] = []; agreements: any[] = []; settlements: any[] = []; chargeTypes: any[] = []; lots: any[] = []; inventorySummary: any[] = []; bankAccounts: any[] = []; account: { entries: any[]; balance: number } = null as any; info = ''; error = ''; saving = false;
  activePanel: 'receive' | 'pattiyal' | 'settle' | 'inventory' | 'setup' = 'receive';
  panelInfo = ''; panelError = '';
  supplier = { supplierCode: '', name: '', phone: '', mobile: '', address: '' };
  receipt: any = { supplierId: null, agreementId: null, businessDate: new Date().toISOString().slice(0, 10), vehicleNo: '', externalReference: '', lines: [{ productId: null, packageQty: null, packageUnit: '', receivedKilos: null, expectedKilos: null, expectedBasePerHandling: null, ratioTolerancePercent: 20, conversionMode: 'variable', unitCost: null }] };
  adjustment: any = { productId: null, handlingQuantity: null, baseQuantity: null, businessDate: new Date().toISOString().slice(0, 10), reason: '' };
  agreement: any = { supplierId: null, ownershipModel: 'consignment', settlementBasis: 'net_sale', commissionRate: 2, paymentTermsDays: null };
  settlement: any = { supplierId: null, fromDate: new Date().toISOString().slice(0, 10), toDate: new Date().toISOString().slice(0, 10) };
  payment: any = { settlementId: null, method: 'cash', amount: null, reference: '', chequeDetails: { bankAccountId: null, chequeNumber: '', chequeDate: '' } };
  charge: any = { supplierId: null, chargeTypeId: null, amount: null, businessDate: new Date().toISOString().slice(0, 10), reason: '' };
  stockCount: any = { businessDate: new Date().toISOString().slice(0, 10), reason: '', lines: [] };
  grnPage = 1; grnPageSize = 10; grnTotal = 0; grnFilters: any = { term: '', supplierId: null, status: '', fromDate: '', toDate: '' };
  grnView: 'posted' | 'drafts' = 'posted'; grnEditorOpen = false; grnReviewMode = false; grnDetail: any = null; correctionSource: any = null; correctionReason = '';
  constructor(private session: SessionService, private printing: PrintingService) {}
  private actor() { return this.session.getActor() || undefined; }
  private api(): any { return window.posApi?.catalog as any; }
  private origin(txnDate?: string): { locCode: string; macCode: string; txnDate: string } {
    const workstation = this.session.getWorkstationSession();
    return {
      locCode: String(workstation?.locationCode || '').trim(),
      macCode: String(workstation?.machineCode || '').trim(),
      txnDate: String(txnDate || this.session.getBillingDate() || '').slice(0, 10)
    };
  }
  private dateInput(value: unknown): string { if (value instanceof Date) { const pad = (part: number) => String(part).padStart(2, '0'); return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`; } return String(value || '').slice(0, 10); }
  async ngOnInit(): Promise<void> { await this.load(); }
  selectPanel(panel: 'receive' | 'pattiyal' | 'settle' | 'inventory' | 'setup'): void { this.activePanel = panel; this.panelInfo = ''; this.panelError = ''; }
  private reportSuccess(message: string): void { this.info = message; this.error = ''; this.panelInfo = message; this.panelError = ''; }
  private reportError(message: string): void { this.error = message; this.info = ''; this.panelError = message; this.panelInfo = ''; }
  get canFinalizeGrn(): boolean { return Boolean(this.receipt.supplierId) && this.receipt.lines.length > 0 && this.receipt.lines.every((line: any) => { const product = this.productForLine(line); if (!product) return false; const handling = Number(line.packageQty || 0); if (!product.dual_uom_enabled) return handling > 0; if (line.conversionMode === 'fixed') return handling > 0 && Number(line.expectedBasePerHandling) > 0; return Number(line.receivedKilos) > 0; }); }
  get grnReadiness(): string { if (!this.receipt.supplierId) return 'Choose the supplier first.'; if (!this.receipt.lines.some((line: any) => line.productId)) return 'Add a product to the GRN line.'; if (!this.canFinalizeGrn) return 'Each line needs its required handling and measured quantities.'; return 'Ready to finalize. This will create immutable lot and stock records.'; }
  async load(): Promise<void> {
    const api = this.api();
    if (!api) return;
    const [suppliers, products, receipts, agreements, settlements, chargeTypes, lots, inventorySummary, bankAccounts] = await Promise.all([
      api.listSuppliers(this.actor()), api.listProducts(), api.listGoodsReceipts({ ...this.grnFilters, scope: this.grnView, page: this.grnPage, pageSize: this.grnPageSize }, this.actor()), api.listSupplyAgreements(null, this.actor()),
      api.listSupplierSettlements(null, this.actor()), api.listSupplierChargeTypes(this.actor()), api.listInventoryLots(null, this.origin().locCode, this.actor()), api.listInventorySummary(this.origin().locCode, this.actor()), api.listBusinessBankAccounts(false, this.actor())
    ]);
    this.suppliers = suppliers.data || []; this.products = products.data || []; this.receipts = receipts.data?.rows || []; this.grnTotal = Number(receipts.data?.total || 0); this.agreements = agreements.data || [];
    this.settlements = settlements.data || []; this.chargeTypes = chargeTypes.data || []; this.lots = lots.data || [];
    this.inventorySummary = inventorySummary.data || [];
    this.bankAccounts = bankAccounts.data || [];
    this.stockCount.lines = this.lots.map((lot: any) => ({ inventoryLotId: lot.id, countedQuantity: lot.remaining_handling_quantity ?? lot.remaining_quantity, countedKilos: lot.remaining_base_quantity ?? lot.remaining_kilos }));
    const failed = [suppliers, receipts, agreements, settlements, chargeTypes, lots, inventorySummary, bankAccounts].find((result: any) => !result.success);
    if (failed) this.reportError(failed.error || 'Some receiving data could not be loaded. Check the role permissions for this workflow.');
  }
  productForLine(line: any): any { return this.products.find((product: any) => Number(product.id) === Number(line.productId)) || null; }
  actualBasePerHandling(line: any): number | null { const handling = Number(line.packageQty); const base = Number(line.receivedKilos); return handling > 0 && base > 0 ? base / handling : null; }
  ratioDeviation(line: any): number | null { const expected = Number(line.expectedBasePerHandling); const actual = this.actualBasePerHandling(line); return expected > 0 && actual != null ? ((actual - expected) / expected) * 100 : null; }
  isVastRatioDeviation(line: any): boolean { const deviation = this.ratioDeviation(line); return deviation != null && Math.abs(deviation) >= Number(line.ratioTolerancePercent || 20); }
  get adjustmentProduct(): any { return this.products.find((product: any) => Number(product.id) === Number(this.adjustment.productId)) || null; }
  onGrnProductChanged(line: any): void { const product = this.productForLine(line); if (!product) return; line.packageUnit = product.handling_uom || 'qty'; line.ratioTolerancePercent = Number(line.ratioTolerancePercent || 20); if (!product.dual_uom_enabled) { line.receivedKilos = null; line.expectedBasePerHandling = null; line.conversionMode = 'variable'; } }
  onConversionModeChanged(line: any): void { if (line.conversionMode === 'fixed') line.receivedKilos = null; }
  addLine(): void { this.receipt.lines.push({ productId: null, packageQty: null, packageUnit: '', receivedKilos: null, expectedKilos: null, expectedBasePerHandling: null, ratioTolerancePercent: 20, conversionMode: 'variable', unitCost: null }); }
  removeLine(index: number): void { if (this.receipt.lines.length > 1) this.receipt.lines.splice(index, 1); }
  get grnPageCount(): number { return Math.max(1, Math.ceil(this.grnTotal / this.grnPageSize)); }
  get grnPageNumbers(): number[] { const count = this.grnPageCount; const start = Math.max(1, Math.min(this.grnPage - 2, count - 4)); return Array.from({ length: Math.min(5, count - start + 1) }, (_, index) => start + index); }
  newGoodsReceipt(): void { this.receipt = { id: null, status: 'draft', documentType: 'receipt', correctsGoodsReceiptId: null, correctionReason: '', supplierId: null, agreementId: null, businessDate: this.session.getBillingDate() || new Date().toISOString().slice(0, 10), vehicleNo: '', externalReference: '', lines: [{ productId: null, packageQty: null, packageUnit: '', receivedKilos: null, expectedKilos: null, expectedBasePerHandling: null, ratioTolerancePercent: 20, conversionMode: 'variable', unitCost: null }] }; this.grnReviewMode = false; this.grnEditorOpen = true; this.grnDetail = null; this.correctionSource = null; }
  async applyGrnFilters(): Promise<void> { this.grnPage = 1; await this.load(); }
  async changeGrnPage(page: number): Promise<void> { this.grnPage = Math.min(this.grnPageCount, Math.max(1, page)); await this.load(); }
  async changeGrnPageSize(): Promise<void> { this.grnPage = 1; await this.load(); }
  async switchGrnView(view: 'posted' | 'drafts'): Promise<void> { this.grnView = view; this.grnPage = 1; this.correctionSource = null; await this.load(); }
  async openGoodsReceipt(id: number): Promise<void> {
    const result = await this.api().getGoodsReceipt(id, this.actor());
    if (!result.success) { this.reportError(result.error || 'Could not load GRN.'); return; }
    const detail = result.data; const receipt = detail.receipt;
    this.receipt = { id: receipt.id, status: receipt.status, documentType: receipt.document_type, correctsGoodsReceiptId: receipt.corrects_goods_receipt_id, correctionReason: receipt.correction_reason || '', supplierId: receipt.supplier_id, agreementId: receipt.agreement_id, businessDate: this.dateInput(receipt.business_date), vehicleNo: receipt.vehicle_no || '', externalReference: receipt.external_reference || '', lines: detail.lines.map((line: any) => ({ productId: line.product_id, sku: line.sku, productName: line.product_name, packageQty: line.handling_quantity ?? line.package_qty, packageUnit: line.handling_uom_snapshot || line.package_unit || 'qty', expectedKilos: line.expected_base_quantity ?? line.expected_kilos, receivedKilos: line.received_base_quantity ?? line.received_kilos, expectedBasePerHandling: line.expected_base_per_handling, ratioTolerancePercent: line.ratio_tolerance_percent ?? 20, conversionMode: line.conversion_mode || 'variable', unitCost: line.unit_cost })) };
    this.grnDetail = detail; this.grnReviewMode = receipt.status !== 'draft'; this.grnEditorOpen = true; this.correctionSource = null;
  }
  closeGoodsReceipt(): void { this.grnEditorOpen = false; this.grnReviewMode = false; this.grnDetail = null; this.correctionSource = null; }
  async saveGoodsReceiptDraft(showMessage = true): Promise<boolean> {
    if (!this.receipt.supplierId || !this.receipt.businessDate) { this.reportError('Supplier and business date are required to save a GRN draft.'); return false; }
    this.saving = true;
    const result = await this.api().saveGoodsReceiptDraft({ ...this.receipt, ...this.origin(this.receipt.businessDate), goodsReceiptId: this.receipt.id || null, userId: this.actor()?.id }, this.actor());
    this.saving = false;
    if (!result.success) { this.reportError(result.error || 'Could not save GRN draft.'); return false; }
    this.receipt.id = result.data.id;
    if (showMessage) this.reportSuccess(`GRN ${result.data.grnNumber} saved as draft.`);
    await this.load(); return true;
  }
  async createSupplier(): Promise<void> { const result = await this.api().createSupplier(this.supplier, this.actor()); if (!result.success) { this.error = result.error || 'Could not create supplier.'; return; } this.supplier = { supplierCode: '', name: '', phone: '', mobile: '', address: '' }; await this.load(); this.receipt.supplierId = result.data.id; this.info = 'Supplier created.'; }
  async finalize(): Promise<void> { if (!this.canFinalizeGrn) { this.reportError(this.grnReadiness); return; } if (!(await this.saveGoodsReceiptDraft(false))) return; this.saving = true; const result = await this.api().finalizeGoodsReceiptDraft(this.receipt.id, this.actor()?.id, this.actor()); this.saving = false; if (!result.success) { this.reportError(result.error || 'Could not finalize GRN.'); return; } this.reportSuccess(`GRN ${result.data.grnNumber} finalized. Stock and supplier entries are now posted.`); this.closeGoodsReceipt(); await this.load(); }
  async cancelGoodsReceipt(): Promise<void> { if (!this.receipt.id) { this.closeGoodsReceipt(); return; } const result = await this.api().cancelGoodsReceiptDraft(this.receipt.id, this.actor()?.id, this.actor()); if (!result.success) { this.reportError(result.error || 'Could not cancel GRN draft.'); return; } this.reportSuccess('GRN draft cancelled. No stock or supplier entries were posted.'); this.closeGoodsReceipt(); await this.load(); }
  beginCorrection(grn: any): void { this.correctionSource = grn; this.correctionReason = ''; }
  async createCorrection(): Promise<void> { if (!this.correctionSource || !this.correctionReason.trim()) { this.reportError('Enter a reason before creating a correction.'); return; } const origin = this.origin(); const result = await this.api().createGoodsReceiptCorrection(this.correctionSource.id, this.correctionReason.trim(), this.actor()?.id, { ...origin, businessDate: origin.txnDate }, this.actor()); if (!result.success) { this.reportError(result.error || 'Could not create correction draft.'); return; } this.reportSuccess(`Correction ${result.data.grnNumber} created on the current business day as a draft.`); await this.load(); await this.openGoodsReceipt(result.data.id); }
  private grnDocument(detail: any): any {
    const receipt = detail.receipt;
    return {
      brand: { name: 'Goods Received Note' },
      meta: [
        { label: 'GRN', value: receipt.grn_number },
        { label: 'Supplier', value: `${receipt.supplier_code || ''} ${receipt.supplier_name}`.trim() },
        { label: 'Business date', value: String(receipt.business_date).slice(0, 10) },
        ...(receipt.vehicle_no ? [{ label: 'Vehicle', value: receipt.vehicle_no }] : []),
        { label: 'Ownership', value: receipt.ownership_model || 'owned' },
        { label: 'Recorded', value: new Date(receipt.created_at).toLocaleString() }
      ],
      items: detail.lines.map((line: any) => ({ description: `${line.sku} ${line.product_name}`, qty: `${Number(line.handling_quantity ?? line.package_qty ?? 0).toFixed(3)} ${line.handling_uom_snapshot || line.package_unit || 'qty'}${line.received_base_quantity != null || line.received_kilos != null ? ` / ${Number(line.received_base_quantity ?? line.received_kilos).toFixed(3)} ${line.base_uom_snapshot || 'base'}` : ''}`, amount: line.unit_cost != null ? Number(line.unit_cost).toFixed(2) : '-' })),
      totals: [{ label: 'LINES', value: String(detail.lines.length), bold: true }]
    };
  }
  private async receiptDetail(id: number): Promise<any | null> { const result = await this.api().getGoodsReceipt(id, this.actor()); if (!result.success) { this.error = result.error || 'Could not load GRN details.'; return null; } return result.data; }
  async printGrn(id: number): Promise<void> { const detail = await this.receiptDetail(id); if (!detail) return; const result = await this.printing.printDocument(this.grnDocument(detail)); this.info = result.success ? 'GRN acknowledgement sent to the receipt printer.' : result.error || 'GRN print failed.'; }
  async saveGrnPdf(id: number): Promise<void> { const detail = await this.receiptDetail(id); if (!detail) return; const number = detail.receipt.grn_number; const result = await this.printing.savePdf(this.grnDocument(detail), { prompt: true, fileName: `${number}.pdf` }); this.info = result.success ? (result.canceled ? 'PDF save canceled.' : `GRN PDF saved to ${result.filePath}.`) : result.error || 'GRN PDF save failed.'; }
  async saveAdjustment(): Promise<void> { const result = await this.api().adjustStock({ ...this.adjustment, ...this.origin(this.adjustment.businessDate) }, this.actor()); if (!result.success) { this.error = result.error || 'Could not save stock adjustment.'; return; } this.info = 'Dual stock adjustment recorded.'; this.adjustment.handlingQuantity = null; this.adjustment.baseQuantity = null; this.adjustment.reason = ''; await this.load(); }
  async createAgreement(): Promise<void> { const result = await this.api().createSupplyAgreement(this.agreement, this.actor()); if (!result.success) { this.error = result.error || 'Could not save agreement.'; return; } this.info = 'Supplier agreement saved.'; await this.load(); }
  get selectedSettlement(): any { return this.settlements.find((item: any) => Number(item.id) === Number(this.payment.settlementId)) || null; }
  get selectedChargeType(): any { return this.chargeTypes.find((item: any) => Number(item.id) === Number(this.charge.chargeTypeId)) || null; }
  ledgerEntries(): any[] { const account = this.account; return account && Array.isArray(account.entries) ? account.entries.slice(0, 8) : []; }
  formatLedgerEntryType(value: unknown): string { return String(value || '').replace(/_/g, ' '); }
  async loadAccount(): Promise<void> { if (!this.settlement.supplierId) { this.account = null as any; return; } const result = await this.api().getSupplierAccount(this.settlement.supplierId, this.actor()); if (!result.success) { this.error = result.error || 'Could not load supplier account.'; return; } this.account = result.data; }
  async createSettlement(): Promise<void> { const result = await this.api().createSupplierSettlement({ ...this.settlement, ...this.origin(), userId: this.actor()?.id }, this.actor()); if (!result.success) { this.error = result.error || 'Could not create settlement.'; return; } this.info = `Settlement ${result.data.settlementNumber} drafted: ${Number(result.data.totalDue).toFixed(2)}.`; await this.load(); await this.loadAccount(); }
  async approveSettlement(id: number): Promise<void> { const result = await this.api().approveSupplierSettlement(id, this.actor()?.id, this.actor()); if (!result.success) { this.error = result.error || 'Could not approve settlement.'; return; } this.info = 'Settlement approved.'; await this.load(); }
  beginSettlementPayment(item: any): void { this.payment = { settlementId: item.id, method: 'cash', amount: Math.max(0, Number(item.total_due || 0) - Number(item.paid_total || 0)), reference: '', chequeDetails: { bankAccountId: this.bankAccounts[0]?.id || null, chequeNumber: '', chequeDate: this.session.getBillingDate() || '' } }; }
  async paySettlement(): Promise<void> { const origin = this.origin(); const result = await this.api().recordSupplierPayment({ ...this.payment, ...origin, businessDate: origin.txnDate, sessionId: this.session.getWorkstationSession()?.sessionId, userId: this.actor()?.id }, this.actor()); if (!result.success) { this.error = result.error || 'Could not record supplier payment.'; return; } this.info = `Payment recorded. Remaining ${Number(result.data.remaining).toFixed(2)}.`; this.payment.amount = null; await this.load(); }
  private settlementDocument(detail: any): any {
    const settlement = detail.settlement;
    const amount = (value: any) => Number(value || 0).toFixed(2);
    return {
      brand: { name: 'Supplier Settlement' },
      meta: [
        { label: 'Settlement', value: settlement.settlement_number },
        { label: 'Supplier', value: `${settlement.supplier_code || ''} ${settlement.supplier_name}`.trim() },
        { label: 'Period', value: `${String(settlement.from_date).slice(0, 10)} to ${String(settlement.to_date).slice(0, 10)}` },
        { label: 'Status', value: settlement.status },
        { label: 'Recorded', value: new Date(settlement.created_at).toLocaleString() }
      ],
      items: detail.lines.map((line: any) => ({ description: `${line.entry_type.replace(/_/g, ' ')}${line.reason ? ` - ${line.reason}` : ''}`, qty: String(line.business_date).slice(0, 10), amount: amount(line.amount) })),
      totals: [
        { label: 'SETTLEMENT DUE', value: amount(settlement.total_due), bold: true },
        { label: 'PAID', value: amount(settlement.paid_total) },
        { label: 'REMAINING', value: amount(Number(settlement.total_due) - Number(settlement.paid_total)), bold: true }
      ]
    };
  }
  private async settlementDetail(id: number): Promise<any | null> {
    const result = await this.api().getSupplierSettlement(id, this.actor());
    if (!result.success) { this.error = result.error || 'Could not load settlement details.'; return null; }
    return result.data;
  }
  async printSettlement(id: number): Promise<void> { const detail = await this.settlementDetail(id); if (!detail) return; const result = await this.printing.printDocument(this.settlementDocument(detail)); this.info = result.success ? 'Settlement sent to the receipt printer.' : result.error || 'Settlement print failed.'; }
  async saveSettlementPdf(id: number): Promise<void> { const detail = await this.settlementDetail(id); if (!detail) return; const number = detail.settlement.settlement_number; const result = await this.printing.savePdf(this.settlementDocument(detail), { prompt: true, fileName: `${number}.pdf` }); this.info = result.success ? (result.canceled ? 'PDF save canceled.' : `Settlement PDF saved to ${result.filePath}.`) : result.error || 'Settlement PDF save failed.'; }
  async addCharge(): Promise<void> { const result = await this.api().addSupplierCharge({ ...this.charge, ...this.origin(this.charge.businessDate), userId: this.actor()?.id }, this.actor()); if (!result.success) { this.error = result.error || 'Could not record charge.'; return; } this.info = 'Supplier charge recorded.'; this.charge.amount = null; this.charge.reason = ''; await this.loadAccount(); }
  async finalizeStockCount(): Promise<void> { const result = await this.api().finalizeStockCount({ ...this.stockCount, ...this.origin(this.stockCount.businessDate), userId: this.actor()?.id }, this.actor()); if (!result.success) { this.error = result.error || 'Could not finalize stock count.'; return; } this.info = 'Stock count finalized.'; await this.load(); }
}
