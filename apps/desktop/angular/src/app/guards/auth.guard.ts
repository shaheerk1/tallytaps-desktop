import { Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { SessionService } from '../services/session.service';

@Injectable({ providedIn: 'root' })
export class AuthGuard implements CanActivate {
  constructor(private session: SessionService, private router: Router) {}

  async canActivate(): Promise<boolean> {
    if (this.session.isLoggedIn()) {
      return true;
    }

    const restored = await this.session.restoreSession();
    if (restored) {
      return true;
    }

    this.router.navigate(['/login']);
    return false;
  }
}
