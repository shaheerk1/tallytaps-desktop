import { Component, OnInit, ViewChild, ElementRef } from '@angular/core';
import { Router } from '@angular/router';
import { SessionService } from '../services/session.service';
import { ShellMenuService } from '../services/shell-menu.service';

type WorkstationOption = {
  id: number;
  location_code: string;
  machine_code: string;
  name: string;
  status: string;
  business_code?: string;
  location_name?: string;
};

@Component({
  selector: 'pos-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css']
})
export class LoginComponent implements OnInit {
  username = '';
  password = '';
  billingDate = '';
  loading = false;
  error = '';
  warning = '';

  workstations: WorkstationOption[] = [];
  selectedWorkstationId: number | null = null;

  @ViewChild('txtUsername') txtUsername!: ElementRef<HTMLInputElement>;
  @ViewChild('txtPassword') txtPassword!: ElementRef<HTMLInputElement>;

  constructor(
    private session: SessionService,
    private router: Router,
    private shellMenu: ShellMenuService
  ) {}

  ngOnInit(): void {
    // Pre-fill billing date from localStorage or default to today
    const storedDate = this.session.getBillingDate();
    if (storedDate) {
      this.billingDate = storedDate;
    } else {
      const today = new Date();
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, '0');
      const d = String(today.getDate()).padStart(2, '0');
      this.billingDate = `${y}-${m}-${d}`;
    }

    // Pre-select the workstation used on the last login (if still active)
    this.selectedWorkstationId = this.session.getSavedWorkstationId();

    // Check for existing session
    if (this.session.isLoggedIn()) {
      this.router.navigate(['/']);
    }

    this.loadWorkstations();

    // Focus username field after render
    setTimeout(() => {
      this.txtUsername?.nativeElement?.focus();
    }, 100);
  }

  private async loadWorkstations(): Promise<void> {
    if (!window.posApi) return;
    try {
      const result = await window.posApi.workstations.list();
      if (result.success) {
        this.workstations = result.data as unknown as WorkstationOption[];
        if (this.workstations.length > 0) {
          const saved = this.workstations.find(w => w.id === this.selectedWorkstationId);
          if (!saved) {
            this.selectedWorkstationId = this.workstations[0].id;
          }
        }
      }
    } catch (err) {
      console.error('Failed to load workstations', err);
    }
  }

  selectWorkstation(id: number): void {
    this.selectedWorkstationId = id;
    this.session.setSavedWorkstationId(id);
  }

  focusPassword(): void {
    this.txtPassword?.nativeElement?.focus();
  }

  onCancel(): void {
    this.username = '';
    this.password = '';
    this.error = '';
    this.warning = '';
    this.txtUsername?.nativeElement?.focus();
  }

  async onLogin(): Promise<void> {
    this.error = '';
    this.warning = '';

    if (!this.username.trim() || !this.password) {
      this.error = 'Username and password are required.';
      return;
    }

    this.loading = true;

    try {
      const result = await this.session.login(
        this.username.trim(),
        this.password,
        this.billingDate || undefined,
        this.selectedWorkstationId || undefined
      );

      if (result.success) {
        if (result.warning) {
          this.warning = result.warning;
        }
        await this.shellMenu.prepare();
        const landing = this.shellMenu.landingRoute || '/';
        await this.router.navigate([landing]);
      } else {
        this.error = result.error || 'Invalid username or password.';
      }
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : 'Login failed. Please try again.';
    } finally {
      this.loading = false;
    }
  }
}
