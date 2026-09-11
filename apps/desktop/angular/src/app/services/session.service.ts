import { Injectable } from '@angular/core';

export type AuthUser = {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  lastLoginAt: string | null;
  permissions: string[];
  roles: Array<{ key: string; name: string }>;
};

export type WorkstationSession = {
  sessionId: number;
  workstationId: number;
  locationCode: string;
  machineCode: string;
  workstationName: string;
  billingDate: string;
  openingBalance: number;
  currentReceiptNo: number;
  workstationSettings: Record<string, unknown>;
  status: 'open' | 'closed';
  openedAt?: string;
};

@Injectable({ providedIn: 'root' })
export class SessionService {
  private user: AuthUser | null = null;
  private token: string | null = null;
  private workstationSession: WorkstationSession | null = null;
  private readonly TOKEN_KEY = 'pos_session_token';
  private readonly BILLING_DATE_KEY = 'pos_billing_date';
  private readonly WORKSTATION_ID_KEY = 'pos_workstation_id';

  constructor() {
    this.token = localStorage.getItem(this.TOKEN_KEY);
  }

  isLoggedIn(): boolean {
    return !!this.user && !!this.token;
  }

  getToken(): string | null {
    return this.token;
  }

  getUser(): AuthUser | null {
    return this.user;
  }

  getWorkstationSession(): WorkstationSession | null {
    return this.workstationSession;
  }

  getBillingDate(): string | null {
    return this.workstationSession?.billingDate || localStorage.getItem(this.BILLING_DATE_KEY);
  }

  /** Apply a new billing date to the in-memory session + persisted prefill. */
  setBillingDateLocal(date: string): void {
    if (this.workstationSession) {
      this.workstationSession = { ...this.workstationSession, billingDate: date };
    }
    localStorage.setItem(this.BILLING_DATE_KEY, date);
  }

  hasPermission(permission: string): boolean {
    if (!this.user) return false;
    return this.user.permissions.includes(permission);
  }

  hasAnyPermission(permissions: string[]): boolean {
    if (!permissions || permissions.length === 0) return true;
    if (!this.user) return false;
    return permissions.some((p) => this.user!.permissions.includes(p));
  }

  hasRole(roleKey: string): boolean {
    if (!this.user) return false;
    return this.user.roles.some((r) => r.key === roleKey);
  }

  getActor(): { id: string; permissions: string[] } | null {
    if (!this.user) return null;
    return {
      id: String(this.user.id),
      permissions: this.user.permissions
    };
  }

  getRoleNames(): string[] {
    if (!this.user) return [];
    return this.user.roles.map((r) => r.name);
  }

  async login(
    username: string,
    password: string,
    billingDate?: string,
    workstationId?: number
  ): Promise<{ success: boolean; warning?: string; error?: string }> {
    if (!window.posApi) return { success: false };

    const result = await window.posApi.auth.login({
      username,
      password,
      billingDate: billingDate || undefined,
      workstationId
    });

    // A refused sign-in carries its reason, such as a cash shift still open on
    // another workstation; the login screen shows it instead of a generic error.
    if (!result.success) return { success: false, error: result.error };

    this.user = result.data.user;
    this.token = result.data.token;
    this.workstationSession = result.data.workstationSession || null;
    localStorage.setItem(this.TOKEN_KEY, this.token);

    if (this.workstationSession?.billingDate) {
      localStorage.setItem(this.BILLING_DATE_KEY, this.workstationSession.billingDate);
    }
    if (workstationId) {
      localStorage.setItem(this.WORKSTATION_ID_KEY, String(workstationId));
    }

    const closedElsewhere = (this.workstationSession as { closedElsewhere?: string[] } | null)?.closedElsewhere || [];
    const moved = closedElsewhere.length
      ? `Your earlier session on ${closedElsewhere.join(', ')} was closed so you could sign in here.`
      : '';
    return {
      success: true,
      warning: [result.data.workstationWarning, moved].filter(Boolean).join(' ') || undefined
    };
  }

  getSavedWorkstationId(): number | null {
    const raw = localStorage.getItem(this.WORKSTATION_ID_KEY);
    const id = raw ? Number(raw) : null;
    return id && Number.isFinite(id) ? id : null;
  }

  setSavedWorkstationId(id: number): void {
    localStorage.setItem(this.WORKSTATION_ID_KEY, String(id));
  }

  async restoreSession(): Promise<boolean> {
    if (!this.token || !window.posApi) return false;

    const result = await window.posApi.auth.validateSession(this.token);
    if (!result.success) {
      this.clear();
      return false;
    }

    this.user = result.data.user;
    this.token = result.data.token;
    this.workstationSession = result.data.workstationSession || null;

    if (this.workstationSession?.billingDate) {
      localStorage.setItem(this.BILLING_DATE_KEY, this.workstationSession.billingDate);
    }

    return true;
  }

  async logout(): Promise<void> {
    if (this.token && window.posApi) {
      await window.posApi.auth.logout(this.token);
    }
    this.clear();
  }

  private clear(): void {
    this.user = null;
    this.token = null;
    this.workstationSession = null;
    localStorage.removeItem(this.TOKEN_KEY);
    // Keep billing date in localStorage for next login pre-fill
  }
}
