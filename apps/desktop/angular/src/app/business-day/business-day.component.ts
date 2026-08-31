import { Component, OnInit } from '@angular/core';
import { SessionService } from '../services/session.service';

@Component({
  selector: 'pos-business-day',
  templateUrl: './business-day.component.html',
  styleUrls: ['./business-day.component.css']
})
export class BusinessDayComponent implements OnInit {
  state: any = null;
  history: any[] = [];
  loading = false;
  error = '';
  info = '';
  closeNote = '';
  resumeReason = '';
  reopenReason = '';
  reopenTarget: any = null;
  nextDate = '';

  constructor(public session: SessionService) {}

  private api(): any { return window.posApi?.businessDays; }

  get locationCode(): string {
    return String(this.session.getWorkstationSession()?.locationCode || '').trim();
  }

  get day(): any { return this.state?.day || null; }
  get summary(): any { return this.state?.summary || null; }
  get blockers(): any[] { return this.state?.blockers || []; }
  get activeBlockers(): any[] { return this.blockers.filter((item) => Number(item.count) > 0); }
  get canStartClose(): boolean { return this.day?.status === 'open' && this.activeBlockers.length === 0; }
  get canView(): boolean { return this.session.hasPermission('business-day.view'); }
  get canOpen(): boolean { return this.session.hasPermission('business-day.open'); }
  get canClose(): boolean { return this.session.hasPermission('business-day.close'); }
  get canReopen(): boolean { return this.session.hasPermission('business-day.reopen'); }

  async ngOnInit(): Promise<void> { await this.load(); }

  async load(message = ''): Promise<void> {
    if (!window.posApi || !this.locationCode) return;
    this.loading = true;
    this.error = '';
    const actor = this.session.getActor();
    const [stateResult, historyResult] = await Promise.all([
      this.api().state(this.locationCode, actor),
      this.api().list(this.locationCode, 60, actor)
    ]);
    this.loading = false;
    if (!stateResult.success) {
      this.error = stateResult.error || 'Could not load business-day control.';
      return;
    }
    this.state = stateResult.data;
    this.history = historyResult.success ? historyResult.data : [];
    const base = this.day?.businessDate || this.state?.lastClosedDay?.businessDate || this.session.getBillingDate();
    this.nextDate = this.addDays(base, 1);
    if (this.day?.businessDate) this.session.setBillingDateLocal(this.day.businessDate);
    if (message) this.info = message;
  }

  async startClosing(): Promise<void> {
    if (!this.day || !this.canStartClose) return;
    await this.run(
      () => this.api().startClosing(this.day.id, this.session.getActor()),
      'Closing review started. Transaction entry is now locked for this business day.'
    );
  }

  async closeDay(): Promise<void> {
    if (!this.day) return;
    await this.run(
      () => this.api().close(this.day.id, this.closeNote.trim(), this.session.getActor()),
      'Business day closed. The recorded date is now read-only.'
    );
    this.closeNote = '';
  }

  async resumeTrading(): Promise<void> {
    if (!this.day || !this.resumeReason.trim()) {
      this.error = 'Enter a reason before cancelling the closing process.';
      return;
    }
    await this.run(
      () => this.api().resumeTrading(this.day.id, this.resumeReason.trim(), this.session.getActor()),
      'Closing was cancelled and transaction entry is open again.'
    );
    this.resumeReason = '';
  }

  async openNextDay(): Promise<void> {
    if (!this.nextDate) return;
    await this.run(
      () => this.api().open(this.locationCode, this.nextDate, this.session.getActor()),
      `Business day ${this.nextDate} opened.`
    );
  }

  chooseReopen(day: any): void {
    this.reopenTarget = day;
    this.reopenReason = '';
    this.error = '';
  }

  async reopenDay(): Promise<void> {
    if (!this.reopenTarget || !this.reopenReason.trim()) {
      this.error = 'A reason is required to reopen a closed business day.';
      return;
    }
    const date = this.reopenTarget.businessDate;
    await this.run(
      () => this.api().reopen(this.reopenTarget.id, this.reopenReason.trim(), this.session.getActor()),
      `Business day ${date} reopened with an audit entry.`
    );
    this.reopenTarget = null;
    this.reopenReason = '';
  }

  private async run(action: () => Promise<any>, successMessage: string): Promise<void> {
    this.loading = true;
    this.error = '';
    this.info = '';
    try {
      const result = await action();
      if (!result.success) {
        this.error = result.error || 'The business-day action could not be completed.';
        return;
      }
      await this.load(successMessage);
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'The business-day action could not be completed.';
    } finally {
      this.loading = false;
    }
  }

  private addDays(value: string | null, days: number): string {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const date = match
      ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      : new Date();
    date.setDate(date.getDate() + days);
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  label(value: string): string {
    return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}
