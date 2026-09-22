import { Injectable } from '@angular/core';
import { SessionService, WorkstationSession } from './session.service';

export type SwitchableWorkstation = {
  id: number;
  name: string;
  locationCode: string;
  machineCode: string;
  locationName: string | null;
};

/** A screen's say before the workstation changes: a reason to ask first, or null. */
export type UnsavedWorkCheck = () => string | null;

/**
 * Moves the signed-in user to another workstation without signing out. The
 * main process closes the session here exactly as signing out does (an open
 * cash shift stays open and is picked up again on return), opens one there and
 * binds this sign-in to it, so every later request comes from the new workstation.
 */
@Injectable({ providedIn: 'root' })
export class WorkstationSwitchService {
  private checks = new Set<UnsavedWorkCheck>();

  constructor(private session: SessionService) {}

  /** A screen with work that would be lost registers a check while it is open. */
  registerUnsavedWork(check: UnsavedWorkCheck): () => void {
    this.checks.add(check);
    return () => this.checks.delete(check);
  }

  /** The first reason any open screen gives for asking before switching. */
  unsavedWork(): string | null {
    for (const check of this.checks) {
      const reason = check();
      if (reason) return reason;
    }
    return null;
  }

  /** Active workstations of active locations, in the order the sign-in screen lists them. */
  async list(): Promise<SwitchableWorkstation[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.workstations.list();
    if (!result.success) return [];
    return ((result.data || []) as any[])
      .filter((row) => row.status === 'active' && row.location_status !== 'retired')
      .map((row) => ({
        id: Number(row.id), name: String(row.name || ''), locationCode: String(row.location_code || ''),
        machineCode: String(row.machine_code || ''), locationName: row.location_name || null
      }));
  }

  /** The workstation after the current one, wrapping round to the first. */
  next(list: SwitchableWorkstation[], currentId: number | null): SwitchableWorkstation | null {
    if (list.length < 2) return null;
    const index = list.findIndex((row) => row.id === currentId);
    return list[(index + 1) % list.length] || null;
  }

  async switchTo(workstationId: number): Promise<{ success: boolean; error?: string; session?: WorkstationSession }> {
    if (!window.posApi) return { success: false, error: 'The app is not connected.' };
    const current = this.session.getWorkstationSession();
    const result = await window.posApi.workstations.switchTo(
      workstationId, current?.billingDate || this.session.getBillingDate() || undefined
    );
    if (!result.success) return { success: false, error: result.error || 'Could not switch workstation.' };
    this.session.adoptWorkstationSession(result.data as WorkstationSession);
    return { success: true, session: result.data as WorkstationSession };
  }
}
