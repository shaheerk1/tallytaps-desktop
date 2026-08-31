import { Injectable } from '@angular/core';
import { SessionService } from './session.service';
import type {
  PrintDocument,
  PrintResult,
  PrinterDevice
} from '../../../../../../packages/shared/ipc/pos-api';

@Injectable({ providedIn: 'root' })
export class PrintingService {
  constructor(private session: SessionService) {}

  private get actor(): { id: string; permissions: string[] } | null {
    return this.session.getActor();
  }

  async list(): Promise<PrinterDevice[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.printing.list(this.actor || undefined);
    if (!result.success) return [];
    return result.data || [];
  }

  async getDefault(): Promise<string | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.printing.defaultGet(this.actor || undefined);
    if (!result.success) return null;
    return result.data ?? null;
  }

  async setDefault(printerId: string): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.printing.defaultSet(printerId, this.actor || undefined);
    return result.success;
  }

  async printDocument(doc: PrintDocument, printerId?: string | null): Promise<PrintResult> {
    if (!window.posApi) {
      return { success: false, error: 'POS bridge unavailable.' };
    }
    const result = await window.posApi.printing.printDocument(doc, printerId || null, this.actor || undefined);
    if (!result.success) {
      return { success: false, error: result.error || 'Print failed.' };
    }
    return result.data;
  }

  async printTestPage(printerId?: string | null): Promise<PrintResult> {
    if (!window.posApi) {
      return { success: false, error: 'POS bridge unavailable.' };
    }
    const result = await window.posApi.printing.printTestPage(printerId || null, this.actor || undefined);
    if (!result.success) {
      return { success: false, error: result.error || 'Print test page failed.' };
    }
    return result.data;
  }

  async savePdf(doc: PrintDocument, options: { prompt?: boolean; directory?: string; fileName?: string }): Promise<{ success: boolean; error?: string; filePath?: string; canceled?: boolean }> {
    if (!window.posApi) return { success: false, error: 'POS bridge unavailable.' };
    const result = await window.posApi.printing.savePdf(doc, options, this.actor || undefined);
    if (!result.success) return { success: false, error: result.error || 'PDF save failed.' };
    return { success: true, ...result.data };
  }
}
