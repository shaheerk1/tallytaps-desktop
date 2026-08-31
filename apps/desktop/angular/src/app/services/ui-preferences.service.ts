import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { SessionService } from './session.service';

export type UiPreferences = {
  autoHide: boolean;
  autoCloseSeconds: number;
  position: 'left' | 'right';
  startupWindowMode: 'normal' | 'maximized' | 'fullscreen';
};

const DEFAULT_PREFS: UiPreferences = {
  autoHide: false,
  autoCloseSeconds: 5,
  position: 'left',
  startupWindowMode: 'normal'
};

const SIDEBAR_MODE_KEY = 'pos_sidebar_mode';

@Injectable({ providedIn: 'root' })
export class UiPreferencesService {
  /**
   * Emits whenever an admin updates the global sidebar settings, so the shell
   * can apply the change live without a reload.
   */
  readonly update$ = new Subject<UiPreferences>();

  constructor(private session: SessionService) {}

  private get actor(): { id: string; permissions: string[] } | null {
    return this.session.getActor();
  }

  /** Read the global sidebar preferences (read-only, safe for any user). */
  async get(): Promise<UiPreferences> {
    if (!window.posApi) return { ...DEFAULT_PREFS };
    const result = await window.posApi.uiPreferences.get();
    if (!result.success) return { ...DEFAULT_PREFS };
    return {
      autoHide: !!result.data.autoHide,
      autoCloseSeconds: Math.max(1, Number(result.data.autoCloseSeconds) || 5),
      position: result.data.position === 'right' ? 'right' : 'left',
      startupWindowMode: ['normal', 'maximized', 'fullscreen'].includes(result.data.startupWindowMode)
        ? result.data.startupWindowMode
        : 'normal'
    };
  }

  /** Persist global sidebar preferences (admin-only) and notify the shell. */
  async save(partial: Partial<UiPreferences>): Promise<UiPreferences> {
    if (!window.posApi) throw new Error('preferences unavailable');
    const result = await window.posApi.uiPreferences.set(partial, this.actor || undefined);
    if (!result.success) throw new Error(result.error || 'Failed to save sidebar settings.');
    const prefs = await this.get();
    this.update$.next(prefs);
    return prefs;
  }

  /**
   * Per-terminal wide/compact mode, remembered from the ☰/✕ toggle usage.
   * First toggle creates the value; later toggles update it; applied on load.
   */
  getSidebarMode(): 'wide' | 'compact' {
    try {
      return localStorage.getItem(SIDEBAR_MODE_KEY) === 'compact' ? 'compact' : 'wide';
    } catch {
      return 'wide';
    }
  }

  setSidebarMode(mode: 'wide' | 'compact'): void {
    try {
      localStorage.setItem(SIDEBAR_MODE_KEY, mode);
    } catch {
      // Non-fatal: preference simply won't persist.
    }
  }
}
