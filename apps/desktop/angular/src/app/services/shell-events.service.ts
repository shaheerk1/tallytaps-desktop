import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ShellEventsService {
  private refreshSubject = new Subject<void>();

  refresh$ = this.refreshSubject.asObservable();

  emitRefresh(): void {
    this.refreshSubject.next();
  }
}
