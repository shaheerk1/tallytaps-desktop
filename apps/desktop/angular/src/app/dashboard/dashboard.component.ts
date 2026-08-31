import { Component, OnInit } from '@angular/core';
import { SessionService, WorkstationSession } from '../services/session.service';

@Component({
  selector: 'pos-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent implements OnInit {
  userName = '';
  userUsername = '';
  userEmail = '';
  userPhone = '';
  userRoles: string[] = [];
  lastLoginAt = '';
  userPermissions: string[] = [];
  wsSession: WorkstationSession | null = null;
  constructor(private session: SessionService) {}

  ngOnInit(): void {
    const user = this.session.getUser();
    if (user) {
      this.userName = user.displayName || user.username;
      this.userUsername = user.username;
      this.userEmail = user.email || '';
      this.userPhone = user.phone || '';
      this.userRoles = user.roles.map((role) => role.name);
      this.userPermissions = user.permissions;
      this.lastLoginAt = user.lastLoginAt ? this.formatDateTime(user.lastLoginAt) : 'First login';
    }
    this.wsSession = this.session.getWorkstationSession();
  }

  private formatDateTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

}
