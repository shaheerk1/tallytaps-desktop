import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';
import { SettingsService } from '../services/settings.service';
import {
  PriorityListService,
  PriorityList,
  AssignmentTarget
} from '../services/priority-list.service';
import { UiPreferencesService } from '../services/ui-preferences.service';
import type { PlatformConfigSnapshot, ReceiptLanguage } from '../../../../../../packages/shared/ipc/pos-api';

type LogoSetting = { enabled: boolean; dataUrl: string };

type FormOption = { id: string; label: string };

type PlatformConfigForm = {
  schemaVersion: number;
  rebuildMode: PlatformConfigSnapshot['rebuildMode'];
  sdlMode: PlatformConfigSnapshot['sdlMode'];
  sdlEffectAreas: PlatformConfigSnapshot['sdlEffectAreas'];
  allowRuntimePluginOverrides: boolean;
  preferRelationalForOperationalData: boolean;
  metadataPolicy: PlatformConfigSnapshot['metadataPolicy'];
  activeVerticalPack: string;
  notes: string;
};

type SettingsForm = {
  general: {
    storeName: string;
    tagline: string;
    address1: string;
    address2: string;
    phone: string;
    currencySymbol: string;
    dateFormat: string;
  };
  billing: {
    billingDate: string;
    defaultTaxRate: number;
    receiptPrefix: string;
    autoSavePdf: boolean;
    pdfFolder: string;
  };
  receipt: {
    language: ReceiptLanguage;
    header1: string;
    header2: string;
    header3: string;
    footer1: string;
    footer2: string;
    logoEnabled: boolean;
    logoDataUrl: string;
  };
  platform: PlatformConfigForm;
};

const CORE_FORMS: FormOption[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'billing', label: 'Billing' },
  { id: 'customers', label: 'Customer Accounts' },
  { id: 'cheques', label: 'Cheque Register' },
  { id: 'users', label: 'Users' },
  { id: 'roles', label: 'Roles' },
  { id: 'items', label: 'Items' },
  { id: 'settings', label: 'Settings' },
  { id: 'field-inbox', label: 'Field Transaction Inbox' },
  { id: 'plugins', label: 'Plugins' }
];

@Component({
  selector: 'pos-settings',
  templateUrl: './settings.component.html',
  styleUrls: ['./settings.component.css']
})
export class SettingsComponent implements OnInit {
  tabs = [
    { id: 'general', label: 'General', icon: '🏪' },
    { id: 'billing', label: 'Billing', icon: '🧾' },
    { id: 'receipt', label: 'Receipt', icon: '🧻' },
    { id: 'platform', label: 'Platform', icon: '🧭' },
    { id: 'ui', label: 'UI Defaults', icon: '🖥️' },
    { id: 'fieldInbox', label: 'Transaction Inbox', icon: '📥' },
    { id: 'printers', label: 'Printers', icon: '🖨️' },
    { id: 'workstations', label: 'Workstations', icon: '💻' }
  ];
  activeTab = 'general';

  isLoading = true;
  errorMessage = '';

  form: SettingsForm = {
    general: {
      storeName: '',
      tagline: '',
      address1: '',
      address2: '',
      phone: '',
      currencySymbol: 'Rs.',
      dateFormat: 'Y-m-d'
    },
    billing: {
      billingDate: '',
      defaultTaxRate: 0,
      receiptPrefix: '',
      autoSavePdf: false,
      pdfFolder: ''
    },
    receipt: {
      language: 'en-LK',
      header1: '',
      header2: '',
      header3: '',
      footer1: '',
      footer2: '',
      logoEnabled: false,
      logoDataUrl: ''
    },
    platform: {
      schemaVersion: 1,
      rebuildMode: 'bounded',
      sdlMode: 'compiled',
      sdlEffectAreas: ['field-rendering', 'input-validation', 'receipt-layout', 'line-calculation', 'bill-calculation'],
      allowRuntimePluginOverrides: false,
      preferRelationalForOperationalData: true,
      metadataPolicy: 'optional-only',
      activeVerticalPack: '',
      notes: ''
    }
  };

  saving = {
    general: false,
    billing: false,
    receipt: false,
    platform: false
  };

  messages = {
    general: '',
    billing: '',
    receipt: '',
    platform: ''
  };

  errors = {
    general: false,
    billing: false,
    receipt: false,
    platform: false
  };

  isError(key: keyof typeof this.errors): boolean {
    return this.errors[key];
  }

  private readonly LOGO_MAX_BYTES = 40 * 1024;

  uiLists: PriorityList[] = [];
  uiSelectedList: PriorityList | null = null;
  uiTargets: AssignmentTarget = { users: [], roles: [] };
  uiFormCatalog: FormOption[] = [];
  uiAddFormId = '';
  uiNewListName = '';
  uiBusy = false;
  uiLoadingLists = false;
  uiError = '';
  uiMessage = '';
  uiMessageError = false;

  sidebarAutoHide = false;
  sidebarAutoCloseSeconds = 5;
  sidebarPosition: 'left' | 'right' = 'left';
  startupWindowMode: 'normal' | 'maximized' | 'fullscreen' = 'normal';
  sidebarSaving = false;
  sidebarMessage = '';
  sidebarMessageError = false;
  platformLoaded = false;
  fieldInboxHostId = '';
  fieldInboxApiKey = '';
  fieldInboxConfigured = false;
  fieldInboxApiBaseUrl = '';
  fieldInboxBusy = false;
  fieldInboxTesting = false;
  fieldInboxMessage = '';
  fieldInboxMessageError = false;
  cloudSyncEnabled = false;
  cloudSyncIntervalMinutes = 15;
  cloudSyncBatchSize = 100;
  cloudSyncMaxBatches = 4;
  cloudSyncNickname = '';
  cloudSyncPendingCount = 0;
  cloudSyncLastSuccess: string | null = null;
  cloudSyncLastError: string | null = null;
  cloudSyncBusy = false;
  cloudSyncMessage = '';
  cloudSyncMessageError = false;

  constructor(
    private session: SessionService,
    private settings: SettingsService,
    private priorityLists: PriorityListService,
    private uiPrefs: UiPreferencesService
  ) {}

  async ngOnInit(): Promise<void> {
    await this.loadData();
    await this.loadPriorityLists();
    await this.loadUiSidebar();
    await this.loadFieldInboxConfiguration();
    await this.loadCloudSyncConfiguration();
  }

  private async loadCloudSyncConfiguration(): Promise<void> {
    if (!window.posApi) return;
    try {
      const result = await window.posApi.cloudSync.getConfiguration(this.session.getActor());
      if (!result.success) throw new Error(result.error);
      this.applyCloudSync(result.data);
    } catch (error) {
      this.cloudSyncMessage = error instanceof Error ? error.message : 'Could not load cloud backup settings.';
      this.cloudSyncMessageError = true;
    }
  }

  async saveCloudSyncConfiguration(): Promise<void> {
    if (!window.posApi || this.cloudSyncBusy) return;
    this.cloudSyncBusy = true; this.cloudSyncMessage = ''; this.cloudSyncMessageError = false;
    try {
      const result = await window.posApi.cloudSync.saveConfiguration({
        enabled: this.cloudSyncEnabled, intervalMinutes: this.cloudSyncIntervalMinutes,
        batchSize: this.cloudSyncBatchSize, maxBatchesPerRun: this.cloudSyncMaxBatches,
        nickname: this.cloudSyncNickname
      }, this.session.getActor());
      if (!result.success) throw new Error(result.error);
      this.applyCloudSync(result.data);
      this.cloudSyncMessage = this.cloudSyncEnabled ? 'Cloud backup schedule saved.' : 'Cloud backup is disabled; local POS operation is unchanged.';
    } catch (error) {
      this.cloudSyncMessage = error instanceof Error ? error.message : 'Could not save cloud backup settings.';
      this.cloudSyncMessageError = true;
    } finally { this.cloudSyncBusy = false; }
  }

  async runCloudSyncNow(): Promise<void> {
    if (!window.posApi || this.cloudSyncBusy || !this.fieldInboxConfigured) return;
    this.cloudSyncBusy = true; this.cloudSyncMessage = 'Preparing changed records…'; this.cloudSyncMessageError = false;
    try {
      const result = await window.posApi.cloudSync.runNow(this.session.getActor());
      if (!result.success) throw new Error(result.error);
      this.applyCloudSync(result.data);
      this.cloudSyncMessage = `Backup complete. ${result.data.uploaded || 0} record changes uploaded${result.data.catalogPublished ? ' and the item catalog was refreshed' : ''}.`;
    } catch (error) {
      this.cloudSyncMessage = error instanceof Error ? error.message : 'Cloud backup failed.';
      this.cloudSyncMessageError = true;
      await this.loadCloudSyncConfiguration();
    } finally { this.cloudSyncBusy = false; }
  }

  private applyCloudSync(data: { enabled: boolean; intervalMinutes: number; batchSize: number; maxBatchesPerRun: number; nickname: string; pendingCount: number; lastSuccessAt: string | null; lastError: string | null }): void {
    this.cloudSyncEnabled = data.enabled; this.cloudSyncIntervalMinutes = data.intervalMinutes;
    this.cloudSyncBatchSize = data.batchSize; this.cloudSyncMaxBatches = data.maxBatchesPerRun;
    this.cloudSyncNickname = data.nickname; this.cloudSyncPendingCount = data.pendingCount;
    this.cloudSyncLastSuccess = data.lastSuccessAt; this.cloudSyncLastError = data.lastError;
  }

  private async loadFieldInboxConfiguration(): Promise<void> {
    if (!window.posApi) return;
    try {
      const result = await window.posApi.fieldInbox.getConfiguration(this.session.getActor());
      if (!result.success) throw new Error(result.error);
      this.fieldInboxHostId = result.data.hostId;
      this.fieldInboxConfigured = result.data.configured;
      this.fieldInboxApiBaseUrl = result.data.apiBaseUrl;
      this.fieldInboxApiKey = '';
    } catch (error) {
      this.fieldInboxMessage = error instanceof Error ? error.message : 'Could not load transaction inbox settings.';
      this.fieldInboxMessageError = true;
    }
  }

  async saveFieldInboxConfiguration(): Promise<void> {
    if (!window.posApi || this.fieldInboxBusy) return;
    this.fieldInboxBusy = true;
    this.fieldInboxMessage = '';
    this.fieldInboxMessageError = false;
    try {
      const result = await window.posApi.fieldInbox.saveConfiguration({
        hostId: this.fieldInboxHostId,
        apiKey: this.fieldInboxApiKey
      }, this.session.getActor());
      if (!result.success) throw new Error(result.error);
      this.fieldInboxConfigured = result.data.configured;
      this.fieldInboxHostId = result.data.hostId;
      this.fieldInboxApiBaseUrl = result.data.apiBaseUrl;
      this.fieldInboxApiKey = '';
      this.fieldInboxMessage = 'Configuration saved securely.';
    } catch (error) {
      this.fieldInboxMessage = error instanceof Error ? error.message : 'Could not save transaction inbox settings.';
      this.fieldInboxMessageError = true;
    } finally {
      this.fieldInboxBusy = false;
    }
  }

  async testFieldInboxConnection(): Promise<void> {
    if (!window.posApi || this.fieldInboxTesting || !this.fieldInboxConfigured) return;
    this.fieldInboxTesting = true;
    this.fieldInboxMessage = '';
    this.fieldInboxMessageError = false;
    try {
      const date = this.form.billing.billingDate || this.session.getBillingDate() || new Date().toISOString().slice(0, 10);
      const result = await window.posApi.fieldInbox.testConnection(date, this.session.getActor());
      if (!result.success) throw new Error(result.error);
      this.fieldInboxMessage = `Connection successful. ${result.data.recordCount} records returned for ${date}.`;
    } catch (error) {
      this.fieldInboxMessage = error instanceof Error ? error.message : 'Connection test failed.';
      this.fieldInboxMessageError = true;
    } finally {
      this.fieldInboxTesting = false;
    }
  }

  async clearFieldInboxConfiguration(): Promise<void> {
    if (!window.posApi || this.fieldInboxBusy || !this.fieldInboxConfigured) return;
    if (!window.confirm('Remove the saved Field Transaction Inbox connection from this POS?')) return;
    this.fieldInboxBusy = true;
    this.fieldInboxMessage = '';
    this.fieldInboxMessageError = false;
    try {
      const result = await window.posApi.fieldInbox.saveConfiguration({
        hostId: this.fieldInboxHostId,
        clearApiKey: true
      }, this.session.getActor());
      if (!result.success) throw new Error(result.error);
      this.fieldInboxConfigured = false;
      this.fieldInboxHostId = '';
      this.fieldInboxApiKey = '';
      this.fieldInboxMessage = 'Saved connection removed. Local resolved markers were retained for audit continuity.';
    } catch (error) {
      this.fieldInboxMessage = error instanceof Error ? error.message : 'Could not remove the saved connection.';
      this.fieldInboxMessageError = true;
    } finally {
      this.fieldInboxBusy = false;
    }
  }

  private async loadUiSidebar(): Promise<void> {
    try {
      const prefs = await this.uiPrefs.get();
      this.sidebarAutoHide = prefs.autoHide;
      this.sidebarAutoCloseSeconds = prefs.autoCloseSeconds;
      this.sidebarPosition = prefs.position === 'right' ? 'right' : 'left';
      this.startupWindowMode = prefs.startupWindowMode;
    } catch (err) {
      console.error('Failed to load sidebar settings', err);
    }
  }

  async saveUiSidebar(): Promise<void> {
    this.sidebarSaving = true;
    this.sidebarMessage = '';
    this.sidebarMessageError = false;
    try {
      await this.uiPrefs.save({
        autoHide: this.sidebarAutoHide,
        autoCloseSeconds: this.sidebarAutoCloseSeconds,
        position: this.sidebarPosition,
        startupWindowMode: this.startupWindowMode
      });
      this.sidebarMessage = 'UI defaults saved. Window mode applies the next time the app starts.';
    } catch (err) {
      console.error('Failed to save sidebar settings', err);
      this.sidebarMessage = err instanceof Error ? err.message : 'Save failed.';
      this.sidebarMessageError = true;
    } finally {
      this.sidebarSaving = false;
    }
  }

  setTab(tab: string): void {
    this.activeTab = tab;
  }

  async loadData(): Promise<void> {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const [general, workstation, billing] = await Promise.all([
        this.settings.getByCode('general'),
        this.settings.getByCode('workstation'),
        this.settings.getByCode('billing')
      ]);

      this.form.general.storeName = String(general['store_name'] ?? workstation['bill_header_1'] ?? '');
      this.form.general.tagline = String(general['store_tagline'] ?? workstation['bill_header_2'] ?? '');
      this.form.general.address1 = String(general['store_address_1'] ?? workstation['store_address_1'] ?? '');
      this.form.general.address2 = String(general['store_address_2'] ?? workstation['store_address_2'] ?? '');
      this.form.general.phone = String(general['store_phone'] ?? workstation['store_phone'] ?? '');
      this.form.general.currencySymbol = String(general['currency_symbol'] ?? 'Rs.');
      this.form.general.dateFormat = String(general['date_format'] ?? 'Y-m-d');

      this.form.billing.billingDate = this.session.getBillingDate() || '';
      this.form.billing.defaultTaxRate = Number(billing['default_tax_rate'] ?? 0);
      this.form.billing.receiptPrefix = String(billing['receipt_prefix'] ?? '');
      this.form.billing.autoSavePdf = billing['auto_save_pdf'] === true || billing['auto_save_pdf'] === 'true';
      this.form.billing.pdfFolder = String(billing['pdf_folder'] ?? '');

      this.form.receipt.header1 = String(workstation['bill_header_1'] ?? '');
      this.form.receipt.language = ['en-LK', 'si-LK', 'ta-LK'].includes(String(workstation['receipt_language']))
        ? String(workstation['receipt_language']) as ReceiptLanguage
        : 'en-LK';
      this.form.receipt.header2 = String(workstation['bill_header_2'] ?? '');
      this.form.receipt.header3 = String(workstation['bill_header_3'] ?? '');
      this.form.receipt.footer1 = String(workstation['bill_footer_1'] ?? '');
      this.form.receipt.footer2 = String(workstation['bill_footer_2'] ?? '');
      const logo = workstation['receipt_logo'] as LogoSetting | undefined;
      this.form.receipt.logoEnabled = !!logo?.enabled;
      this.form.receipt.logoDataUrl = logo?.dataUrl || '';
    } catch (err) {
      console.error('Failed to load settings', err);
      this.errorMessage = 'Failed to load settings.';
    } finally {
      this.isLoading = false;
    }
  }

  // ── Save: General ────────────────────────────────────────

  async saveGeneral(): Promise<void> {
    await this.runSave('general', async () => {
      const g = this.form.general;
      const ok = await this.settings.setBulk('general', {
        currency_symbol: g.currencySymbol,
        date_format: g.dateFormat,
        store_name: g.storeName,
        store_tagline: g.tagline,
        store_address_1: g.address1,
        store_address_2: g.address2,
        store_phone: g.phone
      });
      if (!ok) throw new Error('Failed to save general settings.');
    });
  }

  // ── Save: Billing ────────────────────────────────────────

  async saveBilling(): Promise<void> {
    await this.runSave('billing', async () => {
      const b = this.form.billing;
      const ok = await this.settings.setBulk('billing', {
        default_tax_rate: String(b.defaultTaxRate),
        receipt_prefix: b.receiptPrefix,
        auto_save_pdf: b.autoSavePdf,
        pdf_folder: b.pdfFolder.trim()
      });
      if (!ok) throw new Error('Failed to save billing settings.');
    });
  }

  // ── Save: Receipt ────────────────────────────────────────

  async saveReceipt(): Promise<void> {
    await this.runSave('receipt', async () => {
      const r = this.form.receipt;
      const logo: LogoSetting = {
        enabled: r.logoEnabled,
        dataUrl: r.logoDataUrl
      };
      const ok = await this.settings.setBulk('workstation', {
        receipt_language: r.language,
        bill_header_1: r.header1,
        bill_header_2: r.header2,
        bill_header_3: r.header3,
        bill_footer_1: r.footer1,
        bill_footer_2: r.footer2,
        receipt_logo: logo
      });
      if (!ok) throw new Error('Failed to save receipt settings.');
    });
  }

  // ── Save: Platform ─────────────────────────────────────────────────────────

  // ── Priority Lists ───────────────────────────────────────

  async loadPriorityLists(): Promise<void> {
    this.uiLoadingLists = true;
    this.uiError = '';
    try {
      await this.reloadPriorityLists();
      await this.loadFormCatalog();
      if (this.uiLists.length > 0) {
        this.uiSelectedList =
          this.uiLists.find((l) => l.isDefault) || this.uiLists[0] || null;
      }
    } catch (err) {
      console.error('Failed to load priority lists', err);
      this.uiError = 'Failed to load priority lists.';
    } finally {
      this.uiLoadingLists = false;
    }
  }

  private async reloadPriorityLists(): Promise<void> {
    this.uiLists = await this.priorityLists.list();
    this.uiTargets = await this.priorityLists.assignmentTargets();
  }

  private async loadFormCatalog(): Promise<void> {
    this.uiFormCatalog = [...CORE_FORMS];
  }

  // Retained only to keep the existing settings template stable while the
  // market-specific settings screen is redesigned. It no longer configures
  // runtime behavior.
  savePlatformConfig(): void {
    this.messages.platform = 'Market behavior is fixed in code.';
    this.errors.platform = false;
  }

  hasSdlEffectArea(area: string): boolean {
    return this.form.platform.sdlEffectAreas.includes(area as never);
  }

  setSdlEffectArea(area: string, event: Event): void {
    const enabled = (event.target as HTMLInputElement).checked;
    const values = this.form.platform.sdlEffectAreas.filter((entry) => entry !== area);
    this.form.platform.sdlEffectAreas = enabled ? [...values, area as never] : values;
  }

  uiSelectList(list: PriorityList | null): void {
    this.uiSelectedList = list ? { ...list, assignments: [...list.assignments] } : null;
    this.uiMessage = '';
    this.uiMessageError = false;
  }

  uiEntryLabel(id: string): string {
    return this.uiFormCatalog.find((f) => f.id === id)?.label || id;
  }

  uiAvailableForms(): FormOption[] {
    if (!this.uiSelectedList) return [];
    const used = new Set(this.uiSelectedList.entries);
    return this.uiFormCatalog.filter((f) => !used.has(f.id));
  }

  uiMoveEntry(index: number, delta: number): void {
    const list = this.uiSelectedList;
    if (!list) return;
    const target = index + delta;
    if (target < 0 || target >= list.entries.length) return;
    const entries = [...list.entries];
    const [moved] = entries.splice(index, 1);
    entries.splice(target, 0, moved);
    list.entries = entries;
  }

  uiRemoveEntry(index: number): void {
    const list = this.uiSelectedList;
    if (!list) return;
    list.entries = list.entries.filter((_, i) => i !== index);
  }

  uiAddEntry(): void {
    const list = this.uiSelectedList;
    if (!list || !this.uiAddFormId) return;
    if (!list.entries.includes(this.uiAddFormId)) {
      list.entries = [...list.entries, this.uiAddFormId];
    }
    this.uiAddFormId = '';
  }

  uiIsAssigned(type: 'role' | 'user', targetId: number): boolean {
    const list = this.uiSelectedList;
    if (!list) return false;
    return list.assignments.some((a) => a.targetType === type && a.targetId === targetId);
  }

  uiToggleAssignment(type: 'role' | 'user', targetId: number, event: Event): void {
    const list = this.uiSelectedList;
    if (!list) return;
    const checked = (event.target as HTMLInputElement).checked;
    list.assignments = list.assignments.filter(
      (a) => !(a.targetType === type && a.targetId === targetId)
    );
    if (checked) {
      list.assignments.push({ targetType: type, targetId });
    }
  }

  async uiCreateList(): Promise<void> {
    const name = this.uiNewListName.trim();
    if (!name || this.uiBusy) return;
    this.uiBusy = true;
    this.uiMessage = '';
    this.uiMessageError = false;
    try {
      const created = await this.priorityLists.create({ name, entries: [], isDefault: false });
      if (!created) throw new Error('Failed to create priority list.');
      await this.reloadPriorityLists();
      this.uiSelectList(this.uiLists.find((l) => l.id === created.id) || null);
      this.uiNewListName = '';
      this.uiMessage = 'Priority list created.';
    } catch (err) {
      this.uiMessage = err instanceof Error ? err.message : 'Failed to create priority list.';
      this.uiMessageError = true;
    } finally {
      this.uiBusy = false;
    }
  }

  async uiSaveList(): Promise<void> {
    const list = this.uiSelectedList;
    if (!list || this.uiBusy) return;
    if (!list.name.trim()) {
      this.uiMessage = 'List name is required.';
      this.uiMessageError = true;
      return;
    }
    this.uiBusy = true;
    this.uiMessage = '';
    this.uiMessageError = false;
    try {
      await this.priorityLists.update(list.id, {
        name: list.name.trim(),
        entries: list.entries
      });
      await this.priorityLists.setAssignments(list.id, list.assignments);
      await this.reloadPriorityLists();
      this.uiSelectList(this.uiLists.find((l) => l.id === list.id) || null);
      this.uiMessage = 'Priority list saved.';
    } catch (err) {
      this.uiMessage = err instanceof Error ? err.message : 'Save failed.';
      this.uiMessageError = true;
    } finally {
      this.uiBusy = false;
    }
  }

  async uiSetDefault(id: number, checked: boolean): Promise<void> {
    const list = this.uiSelectedList;
    if (!list || this.uiBusy) return;
    if (!checked) {
      list.isDefault = true;
      return;
    }
    this.uiBusy = true;
    this.uiMessage = '';
    this.uiMessageError = false;
    try {
      await this.priorityLists.setDefault(id);
      await this.reloadPriorityLists();
      this.uiSelectList(this.uiLists.find((l) => l.id === id) || null);
      this.uiMessage = 'Default list updated.';
    } catch (err) {
      this.uiMessage = err instanceof Error ? err.message : 'Failed to set default list.';
      this.uiMessageError = true;
    } finally {
      this.uiBusy = false;
    }
  }

  async uiDeleteList(): Promise<void> {
    const list = this.uiSelectedList;
    if (!list || list.isDefault || this.uiBusy) return;
    const confirmed = window.confirm(
      `Delete priority list "${list.name}"? Assigned users will fall back to the Default list.`
    );
    if (!confirmed) return;
    this.uiBusy = true;
    this.uiMessage = '';
    this.uiMessageError = false;
    try {
      await this.priorityLists.delete(list.id);
      await this.reloadPriorityLists();
      this.uiSelectedList =
        this.uiLists.find((l) => l.isDefault) || this.uiLists[0] || null;
      this.uiMessage = 'Priority list deleted.';
    } catch (err) {
      this.uiMessage = err instanceof Error ? err.message : 'Delete failed.';
      this.uiMessageError = true;
    } finally {
      this.uiBusy = false;
    }
  }

  // ── Logo upload ──────────────────────────────────────────

  onLogoFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.messages.receipt = 'Please select a valid image file (PNG, JPG, etc.).';
      return;
    }
    if (file.size > this.LOGO_MAX_BYTES) {
      this.messages.receipt = 'Logo must be smaller than 40 KB (kept compact for the receipt).';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      this.form.receipt.logoDataUrl = String(reader.result || '');
      this.form.receipt.logoEnabled = true;
      this.messages.receipt = 'Logo loaded — press Save Receipt to persist it.';
    };
    reader.readAsDataURL(file);
    input.value = '';
  }

  removeLogo(): void {
    this.form.receipt.logoDataUrl = '';
    this.form.receipt.logoEnabled = false;
    this.messages.receipt = 'Logo removed — press Save Receipt to persist the change.';
  }

  // ── Shared ───────────────────────────────────────────────

  private async runSave(key: keyof typeof this.saving, fn: () => Promise<void>): Promise<void> {
    this.saving[key] = true;
    this.messages[key] = '';
    this.errors[key] = false;
    try {
      await fn();
      this.messages[key] = 'Saved successfully.';
    } catch (err) {
      console.error('Save failed', err);
      this.messages[key] = err instanceof Error ? err.message : 'Save failed.';
      this.errors[key] = true;
    } finally {
      this.saving[key] = false;
    }
  }
}
