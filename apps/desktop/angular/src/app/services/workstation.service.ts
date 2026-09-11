import { Injectable } from '@angular/core';
import { SessionService, WorkstationSession } from './session.service';

export type Workstation = {
  id: number;
  location_code: string;
  machine_code: string;
  name: string;
  status: string;
  created_at: string;
  business_code?: string;
  location_name?: string;
  location_status?: 'active' | 'retired';
};

@Injectable({ providedIn: 'root' })
export class WorkstationService {
  constructor(private session: SessionService) {}

  private get actor(): { id: string; permissions: string[] } | null {
    return this.session.getActor();
  }

  async list(): Promise<Workstation[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.workstations.list();
    if (!result.success) return [];
    return result.data as unknown as Workstation[];
  }

  async listAll(): Promise<Workstation[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.workstations.listAll(this.actor);
    if (!result.success) return [];
    return result.data as unknown as Workstation[];
  }

  async create(payload: {
    locationCode: string;
    machineCode: string;
    name: string;
    status?: string;
  }): Promise<Workstation | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.workstations.create(payload, this.actor);
    if (!result.success) return null;
    return result.data as unknown as Workstation;
  }

  async update(id: number, payload: { name?: string; status?: string }): Promise<Workstation | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.workstations.update(id, payload, this.actor);
    if (!result.success) return null;
    return result.data as unknown as Workstation;
  }

  async delete(id: number): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.workstations.delete(id, this.actor);
    return result.success;
  }

  async updateSessionDate(userId: number, billingDate: string): Promise<WorkstationSession | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.workstations.updateSessionDate(userId, billingDate, this.actor);
    if (!result.success) return null;
    return result.data as unknown as WorkstationSession;
  }
}
