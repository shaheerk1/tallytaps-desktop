import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { SessionService } from './services/session.service';
import { ShellMenuService, MenuEntry } from './services/shell-menu.service';
import { UiPreferencesService, UiPreferences } from './services/ui-preferences.service';
import { SwitchableWorkstation, WorkstationSwitchService } from './services/workstation-switch.service';

@Component({
  selector: 'pos-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  coreMenu: MenuEntry[] = [];
  allMenu: MenuEntry[] = [];
  userName = '';
  userRole = '';
  isReady = false;
  showSidebar = false;

  // ── Workstation pill ──────────────────────────────────
  workstations: SwitchableWorkstation[] = [];
  switchingWorkstation = false;
  /** Swapped off and on to rebuild the open page on the new workstation. */
  workspaceVisible = true;
  switchNotice = '';
  switchError = '';
  confirmSwitchTo: SwitchableWorkstation | null = null;
  confirmSwitchReason = '';
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Sidebar state ─────────────────────────────────────
  sidebarMode: 'wide' | 'compact' = 'wide';
  sidebarAutoHide = false;
  sidebarAutoCloseSeconds = 5;
  sidebarHidden = false;
  sidebarPosition: 'left' | 'right' = 'left';

  get sidebarCollapsed(): boolean {
    return this.sidebarMode === 'compact';
  }

  /** Floating-tab glyph points toward the screen edge the sidebar sits on. */
  get sidebarTabGlyph(): string {
    const towardRight = this.sidebarPosition === 'left';
    return towardRight === !this.sidebarHidden ? '<' : '>';
  }

  private uiPrefsApplied = false;
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private uiPrefsSub: Subscription | null = null;

  constructor(
    private session: SessionService,
    private router: Router,
    private shellMenu: ShellMenuService,
    private uiPrefs: UiPreferencesService,
    private workstationSwitch: WorkstationSwitchService
  ) {}

  async ngOnInit(): Promise<void> {
    // Apply sidebar preferences live when an admin changes them.
    this.uiPrefsSub = this.uiPrefs.update$.subscribe((prefs) => this.applyUiPrefs(prefs));

    // Track route changes to show/hide sidebar and reload shell data
    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(async (event) => {
        const navEnd = event as NavigationEnd;
        const isLoginPage = navEnd.urlAfterRedirects === '/login';

        if (isLoginPage) {
          this.showSidebar = false;
        } else if (this.session.isLoggedIn() && !this.userName) {
          // Fresh login: session exists but shell data not loaded yet
          await this.loadShellData();
        }
      });

    if (!window.posApi) {
      this.isReady = true;
      return;
    }

    // Try to restore session from stored token
    const restored = await this.session.restoreSession();
    if (!restored) {
      this.isReady = true;
      return;
    }

    await this.loadShellData();
    await this.navigateToLanding();
  }

  ngOnDestroy(): void {
    this.uiPrefsSub?.unsubscribe();
    this.clearAutoClose();
  }

  /** F10 opens a fresh billing screen from anywhere outside Billing itself. */
  @HostListener('window:keydown', ['$event'])
  onNewBillHotkey(event: KeyboardEvent): void {
    if (event.key !== 'F10' || event.repeat || !this.session.isLoggedIn()) return;
    if (this.router.url.startsWith('/billing')) return;
    event.preventDefault();
    void this.router.navigate(['/billing']);
  }

  async loadShellData(): Promise<void> {
    const user = this.session.getUser();
    this.userName = user?.displayName || '';
    this.userRole = user?.roles.map((r) => r.name).join(', ') || '';
    this.showSidebar = true;

    if (!this.uiPrefsApplied) {
      const prefs = await this.uiPrefs.get();
      this.uiPrefsApplied = true;
      this.applyUiPrefs(prefs, { initial: true });
    }

    await this.shellMenu.prepare();

    this.coreMenu = this.shellMenu.coreMenu;
    this.allMenu = this.shellMenu.allMenu;
    this.workstations = await this.workstationSwitch.list();

    this.isReady = true;
  }

  // ── Workstation pill ──────────────────────────────────

  get currentWorkstation(): { name: string; code: string } | null {
    const ws = this.session.getWorkstationSession();
    return ws ? { name: ws.workstationName, code: `${ws.locationCode} / ${ws.machineCode}` } : null;
  }

  get nextWorkstation(): SwitchableWorkstation | null {
    return this.workstationSwitch.next(this.workstations, this.session.getWorkstationSession()?.workstationId ?? null);
  }

  /** Ctrl+Shift+W moves to the next workstation, like the switch button. */
  @HostListener('window:keydown', ['$event'])
  onSwitchHotkey(event: KeyboardEvent): void {
    if (!(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'w') || event.repeat || !this.session.isLoggedIn()) return;
    event.preventDefault();
    void this.switchToNext();
  }

  async switchToNext(): Promise<void> {
    if (this.switchingWorkstation) return;
    this.workstations = await this.workstationSwitch.list();
    const target = this.nextWorkstation;
    if (!target) return;
    // A screen with work in progress (a bill being built) is asked first.
    const reason = this.workstationSwitch.unsavedWork();
    if (reason) {
      this.confirmSwitchTo = target;
      this.confirmSwitchReason = reason;
      return;
    }
    await this.switchTo(target);
  }

  cancelSwitch(): void {
    this.confirmSwitchTo = null;
    this.confirmSwitchReason = '';
  }

  async confirmSwitch(): Promise<void> {
    const target = this.confirmSwitchTo;
    this.cancelSwitch();
    if (target) await this.switchTo(target);
  }

  private async switchTo(target: SwitchableWorkstation): Promise<void> {
    this.switchingWorkstation = true;
    this.switchError = '';
    const result = await this.workstationSwitch.switchTo(target.id);
    this.switchingWorkstation = false;
    if (!result.success) {
      this.switchError = result.error || 'Could not switch workstation.';
      this.flashNotice();
      return;
    }
    // Menus and the open page are rebuilt for the new workstation, so nothing
    // shown or held on screen still belongs to the old one.
    await this.shellMenu.prepare();
    this.coreMenu = this.shellMenu.coreMenu;
    this.allMenu = this.shellMenu.allMenu;
    this.workspaceVisible = false;
    setTimeout(() => { this.workspaceVisible = true; });
    this.switchNotice = `Now on ${target.name} (${target.locationCode} / ${target.machineCode})`;
    this.flashNotice();
  }

  private flashNotice(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.switchNotice = ''; this.switchError = ''; this.noticeTimer = null; }, 6000);
  }

  /**
   * Apply sidebar preferences. On initial load the bar starts hidden when
   * auto-hide is on; live admin updates only adjust the flags.
   */
  private applyUiPrefs(prefs: UiPreferences, opts: { initial?: boolean } = {}): void {
    this.sidebarAutoHide = prefs.autoHide;
    this.sidebarAutoCloseSeconds = prefs.autoCloseSeconds;
    this.sidebarPosition = prefs.position === 'right' ? 'right' : 'left';

    if (opts.initial) {
      this.sidebarMode = this.uiPrefs.getSidebarMode();
      this.sidebarHidden = prefs.autoHide;
      if (!prefs.autoHide) {
        this.clearAutoClose();
      }
    } else {
      if (!prefs.autoHide) {
        this.sidebarHidden = false;
        this.clearAutoClose();
      } else if (!this.sidebarHidden) {
        this.startAutoClose();
      }
    }
  }

  /**
   * Navigate to the resolved priority list's first permitted form once after
   * login/session restore. The user can still click Dashboard afterwards.
   */
  private async navigateToLanding(): Promise<void> {
    const route = this.shellMenu.landingRoute;
    if (!route || this.router.url === route) return;
    await this.router.navigate([route]);
  }

  // ── Sidebar actions ───────────────────────────────────

  /** ☰/✕ header toggle: switches wide/compact and persists the choice. */
  toggleSidebar(): void {
    this.sidebarMode = this.sidebarMode === 'wide' ? 'compact' : 'wide';
    this.uiPrefs.setSidebarMode(this.sidebarMode);
  }

  /** Floating > / < tab (auto-hide mode): show/hide the bar. */
  toggleSidebarHidden(): void {
    this.sidebarHidden = !this.sidebarHidden;
    if (this.sidebarHidden) {
      this.clearAutoClose();
    } else {
      this.startAutoClose();
    }
  }

  /** Close the bar after navigating when auto-hide is on. */
  onNavClick(): void {
    if (this.sidebarAutoHide && !this.sidebarHidden) {
      this.sidebarHidden = true;
      this.clearAutoClose();
    }
  }

  onSidebarMouseEnter(): void {
    this.clearAutoClose();
  }

  onSidebarMouseLeave(): void {
    this.startAutoClose();
  }

  private startAutoClose(): void {
    this.clearAutoClose();
    if (!this.sidebarAutoHide || this.sidebarHidden || this.sidebarAutoCloseSeconds <= 0) {
      return;
    }
    this.autoCloseTimer = setTimeout(() => {
      this.sidebarHidden = true;
      this.autoCloseTimer = null;
    }, this.sidebarAutoCloseSeconds * 1000);
  }

  private clearAutoClose(): void {
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
  }

  async onLogout(): Promise<void> {
    await this.session.logout();
    this.shellMenu.clear();
    this.coreMenu = [];
    this.allMenu = [];
    this.userName = '';
    this.userRole = '';
    this.workstations = [];
    this.cancelSwitch();
    this.showSidebar = false;
    this.sidebarMode = 'wide';
    this.sidebarHidden = false;
    this.sidebarPosition = 'left';
    this.clearAutoClose();
    this.uiPrefsApplied = false;
    await this.router.navigate(['/login']);
  }
}
