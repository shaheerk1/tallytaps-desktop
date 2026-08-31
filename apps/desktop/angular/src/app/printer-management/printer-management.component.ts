import { Component, OnInit } from '@angular/core';
import { PrintingService } from '../services/printing.service';
import type { PrintDocument, PrinterDevice } from '../../../../../../packages/shared/ipc/pos-api';

@Component({
  selector: 'pos-printer-management',
  templateUrl: './printer-management.component.html',
  styleUrls: ['./printer-management.component.css']
})
export class PrinterManagementComponent implements OnInit {
  printers: PrinterDevice[] = [];
  isLoading = true;
  isSaving = false;
  errorMessage = '';
  infoMessage = '';
  resultMessage = '';
  resultIsError = false;

  constructor(private printing: PrintingService) {}

  async ngOnInit(): Promise<void> {
    await this.loadData();
  }

  async loadData(): Promise<void> {
    this.isLoading = true;
    this.errorMessage = '';
    this.resultMessage = '';
    try {
      this.printers = await this.printing.list();
    } catch (err) {
      console.error('Failed to load printers', err);
      this.errorMessage = 'Failed to load printers.';
    } finally {
      this.isLoading = false;
    }
  }

  get defaultId(): string | null {
    return this.printers.find((p) => p.isDefault)?.id || null;
  }

  async setAsDefault(printerId: string): Promise<void> {
    this.isSaving = true;
    this.resultMessage = '';
    try {
      const ok = await this.printing.setDefault(printerId);
      this.infoMessage = ok ? 'Default printer saved.' : 'Could not save default printer.';
      await this.loadData();
    } catch (err) {
      console.error('Failed to set default printer', err);
      this.infoMessage = 'Failed to set default printer.';
    } finally {
      this.isSaving = false;
    }
  }

  async printTest(printerId: string | null): Promise<void> {
    this.resultMessage = '';
    this.resultIsError = false;
    try {
      const result = await this.printing.printTestPage(printerId);
      if (result.success) {
        this.resultMessage = result.message || 'Test page printed successfully.';
      } else {
        this.resultIsError = true;
        this.resultMessage = result.error || 'Print test page failed.';
      }
    } catch (err) {
      this.resultIsError = true;
      this.resultMessage = err instanceof Error ? err.message : 'Print test page failed.';
    }
  }

  async printSampleReceipt(printerId: string | null): Promise<void> {
    this.resultMessage = '';
    this.resultIsError = false;
    const doc: PrintDocument = {
      headerLines: ['POS PLATFORM', 'Sample Store'],
      addressLines: ['12 High Street, Colombo'],
      meta: [
        { label: 'Receipt', value: '#1001' },
        { label: 'Date', value: new Date().toLocaleString() },
        { label: 'Cashier', value: 'admin' }
      ],
      items: [
        {
          description: 'Fresh Carrots',
          qty: '2.500 kg x 100.00',
          amount: 'Rs. 250.00',
          extras: [{ label: 'Owner', value: 'Ali' }]
        },
        {
          description: 'Tomatoes',
          qty: '3 x 80.00',
          amount: 'Rs. 240.00'
        }
      ],
      totals: [
        { label: 'Subtotal', value: 'Rs. 490.00' },
        { label: 'TOTAL', value: 'Rs. 490.00', bold: true }
      ],
      footerLines: ['Thank you for your business!'],
      barcode: '1001',
      qrCode: 'POS|SAMPLE|1001'
    };
    try {
      const result = await this.printing.printDocument(doc, printerId);
      if (result.success) {
        this.resultMessage = result.message || 'Sample receipt printed successfully.';
      } else {
        this.resultIsError = true;
        this.resultMessage = result.error || 'Print sample receipt failed.';
      }
    } catch (err) {
      this.resultIsError = true;
      this.resultMessage = err instanceof Error ? err.message : 'Print sample receipt failed.';
    }
  }
}
