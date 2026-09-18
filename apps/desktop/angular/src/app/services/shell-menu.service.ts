import { Injectable } from '@angular/core';
import { SessionService } from './session.service';

export type MenuEntry = {
  id: string;
  label: string;
  route: string;
  icon?: string;
  order?: number;
  core?: boolean;
};

@Injectable({ providedIn: 'root' })
export class ShellMenuService {
  coreMenu: MenuEntry[] = [];
  allMenu: MenuEntry[] = [];
  landingRoute: string | null = null;

  constructor(private session: SessionService) {}

  async prepare(): Promise<void> {
    this.coreMenu = this.buildCoreMenu();
    const priority = await this.resolvePriorityEntries();
    this.allMenu = this.orderByPriority(this.coreMenu, priority);
    this.landingRoute = this.resolveLandingRoute(this.allMenu, priority);
  }

  clear(): void {
    this.coreMenu = [];
    this.allMenu = [];
    this.landingRoute = null;
  }

  private buildCoreMenu(): MenuEntry[] {
    const icon = (file: string) => `assets/sidebaricons/${file}`;
    const core: MenuEntry[] = [{ id: 'dashboard', label: 'Dashboard', route: '/', icon: icon('dashboard.png'), order: 0, core: true }];
    if (this.session.hasAnyPermission(['billing.create', 'billing.view'])) core.push({ id: 'billing', label: 'Billing', route: '/billing', icon: icon('billing.png'), order: 1, core: true });
    if (this.session.hasPermission('billing.view')) core.push({ id: 'invoices', label: 'Invoice Archive', route: '/invoices', icon: icon('invoices_archive.png'), order: 1.25, core: true });
    if (this.session.hasAnyPermission(['customers.view', 'receivables.view'])) core.push({ id: 'customers', label: 'Customer Accounts', route: '/customers', icon: icon('customer_accounts.png'), order: 1.3, core: true });
    if (this.session.hasPermission('cheques.view')) core.push({ id: 'cheques', label: 'Cheque Register', route: '/cheques', icon: icon('cheque.png'), order: 1.35, core: true });
    if (this.session.hasAnyPermission(['refund.create', 'refund.view'])) core.push({ id: 'refunds', label: 'Refunds', route: '/refunds', icon: icon('refunds.png'), order: 1.5, core: true });
    if (this.session.hasAnyPermission(['cash.shift.view', 'cash.shift.open'])) core.push({ id: 'cash-management', label: 'Cash Management', route: '/cash-management', icon: icon('cash_management.png'), order: 1.75, core: true });
    if (this.session.hasPermission('business-day.view')) core.push({ id: 'business-day', label: 'Business Day', route: '/business-day', icon: icon('business_day.png'), order: 1.8, core: true });
    if (this.session.hasPermission('users.manage')) {
      core.push({ id: 'users', label: 'Users', route: '/users', icon: icon('users.png'), order: 2, core: true });
      core.push({ id: 'roles', label: 'Roles', route: '/roles', icon: icon('shield.png'), order: 3, core: true });
    }
    if (this.session.hasPermission('products.manage')) core.push({ id: 'items', label: 'Items', route: '/items', icon: icon('items.png'), order: 2.5, core: true });
    if (this.session.hasAnyPermission(['receiving.view', 'receiving.manage', 'supplier-settlements.view', 'supplier-settlements.manage'])) core.push({ id: 'receiving', label: 'Supplier Receiving', route: '/receiving', icon: icon('supplier_receiving.png'), order: 2.6, core: true });
    if (this.session.hasAnyPermission(['supplier-settlements.view', 'supplier-settlements.manage'])) core.push({ id: 'supplier-accounts', label: 'Supplier Accounts', route: '/supplier-accounts', icon: icon('supplier.png'), order: 2.62, core: true });
    if (this.session.hasAnyPermission(['expenses.view', 'funds.view', 'lot-costing.view', 'stakeholders.view', 'accounting.journal.view'])) core.push({ id: 'expenses', label: 'Money', route: '/expenses', icon: icon('expenses.png'), order: 2.65, core: true });
    if (this.session.hasPermission('reports.view')) core.push({ id: 'reports', label: 'Reports', route: '/reports', icon: icon('reports.png'), order: 2.7, core: true });
    if (this.session.hasPermission('field-inbox.view')) core.push({ id: 'field-inbox', label: 'Field Transaction Inbox', route: '/field-inbox', icon: icon('field_transaction_inbox.png'), order: 2.75, core: true });
    if (this.session.hasPermission('settings.manage')) core.push({ id: 'settings', label: 'Settings', route: '/settings', icon: icon('setting.png'), order: 3.5, core: true });
    return core;
  }

  private async resolvePriorityEntries(): Promise<string[]> {
    const user = this.session.getUser();
    if (!user || !window.posApi) return [];
    try {
      const result = await window.posApi.priorityLists.resolveForUser(user.id);
      return result.success && Array.isArray(result.data.entries) ? result.data.entries : [];
    } catch {
      return [];
    }
  }

  private orderByPriority(core: MenuEntry[], priority: string[]): MenuEntry[] {
    const byId = new Map(core.map((entry) => [entry.id, entry]));
    const ordered: MenuEntry[] = [];
    for (const id of priority) {
      const entry = byId.get(id);
      if (entry) ordered.push(entry);
    }
    for (const entry of core) if (!ordered.some((item) => item.id === entry.id)) ordered.push(entry);
    return ordered;
  }

  private resolveLandingRoute(menu: MenuEntry[], priority: string[]): string | null {
    for (const id of priority) {
      const entry = menu.find((item) => item.id === id);
      if (entry) return entry.route;
    }
    return menu[0]?.route || null;
  }
}
