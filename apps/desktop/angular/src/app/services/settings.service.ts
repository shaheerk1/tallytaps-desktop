import { Injectable } from '@angular/core';
import { SessionService } from './session.service';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  constructor(private session: SessionService) {}

  private get actor(): { id: string; permissions: string[] } | null {
    return this.session.getActor();
  }

  async get(code: string, key: string): Promise<unknown> {
    if (!window.posApi) return undefined;
    const result = await window.posApi.settings.get(code, key, this.actor || undefined);
    if (!result.success) return undefined;
    return result.data ?? undefined;
  }

  async getByCode(code: string): Promise<Record<string, unknown>> {
    if (!window.posApi) return {};
    const result = await window.posApi.settings.getByCode(code, this.actor || undefined);
    if (!result.success) return {};
    return result.data || {};
  }

  async set(code: string, key: string, value: unknown): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.settings.set(code, key, value, this.actor || undefined);
    return result.success;
  }

  async setBulk(code: string, settings: Record<string, unknown>): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.settings.setBulk(code, settings, this.actor || undefined);
    return result.success;
  }

  async delete(code: string, key: string): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.settings.delete(code, key, this.actor || undefined);
    return result.success;
  }

  async listCodes(): Promise<string[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.settings.listCodes(this.actor || undefined);
    if (!result.success) return [];
    return result.data || [];
  }

}
