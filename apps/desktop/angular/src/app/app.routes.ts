import { Routes } from '@angular/router';

import { DashboardComponent } from './dashboard/dashboard.component';
import { BillingComponent } from './billing/billing.component';
import { RefundComponent } from './refund/refund.component';
import { CashManagementComponent } from './cash-management/cash-management.component';
import { InvoiceHistoryComponent } from './invoice-history/invoice-history.component';
import { LoginComponent } from './login/login.component';
import { UserManagementComponent } from './user-management/user-management.component';
import { RoleManagementComponent } from './role-management/role-management.component';
import { WorkstationManagementComponent } from './workstation-management/workstation-management.component';
import { ItemManagementComponent } from './item-management/item-management.component';
import { PrinterManagementComponent } from './printer-management/printer-management.component';
import { SettingsComponent } from './settings/settings.component';
import { CustomerAccountsComponent } from './customer-accounts/customer-accounts.component';
import { ChequeRegisterComponent } from './cheque-register/cheque-register.component';
import { SupplyReceivingComponent } from './supply-receiving/supply-receiving.component';
import { ReportsComponent } from './reports/reports.component';
import { FieldTransactionInboxComponent } from './field-transaction-inbox/field-transaction-inbox.component';
import { BusinessDayComponent } from './business-day/business-day.component';
import { AuthGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    component: LoginComponent,
    title: 'Sign In'
  },
  {
    path: '',
    component: DashboardComponent,
    title: 'Tally Taps',
    canActivate: [AuthGuard]
  },
  {
    path: 'billing',
    component: BillingComponent,
    title: 'Billing',
    canActivate: [AuthGuard]
  },
  {
    path: 'refunds',
    component: RefundComponent,
    title: 'Refunds',
    canActivate: [AuthGuard]
  },
  {
    path: 'cash-management',
    component: CashManagementComponent,
    title: 'Cash Management',
    canActivate: [AuthGuard]
  },
  { path: 'business-day', component: BusinessDayComponent, title: 'Business Day Control', canActivate: [AuthGuard] },
  { path: 'invoices', component: InvoiceHistoryComponent, title: 'Invoice Archive', canActivate: [AuthGuard] },
  { path: 'customers', component: CustomerAccountsComponent, title: 'Customer Accounts', canActivate: [AuthGuard] },
  { path: 'cheques', component: ChequeRegisterComponent, title: 'Cheque Register', canActivate: [AuthGuard] },
  { path: 'receiving', component: SupplyReceivingComponent, title: 'Supplier Receiving', canActivate: [AuthGuard] },
  { path: 'reports', component: ReportsComponent, title: 'Reports', canActivate: [AuthGuard] },
  { path: 'field-inbox', component: FieldTransactionInboxComponent, title: 'Field Transaction Inbox', canActivate: [AuthGuard] },
  {
    path: 'users',
    component: UserManagementComponent,
    title: 'User Management',
    canActivate: [AuthGuard]
  },
  {
    path: 'roles',
    component: RoleManagementComponent,
    title: 'Role Management',
    canActivate: [AuthGuard]
  },
  {
    path: 'workstations',
    component: WorkstationManagementComponent,
    title: 'Workstations',
    canActivate: [AuthGuard]
  },
  {
    path: 'items',
    component: ItemManagementComponent,
    title: 'Item Management',
    canActivate: [AuthGuard]
  },
  {
    path: 'printers',
    component: PrinterManagementComponent,
    title: 'Printer Management',
    canActivate: [AuthGuard]
  },
  {
    path: 'settings',
    component: SettingsComponent,
    title: 'Settings',
    canActivate: [AuthGuard]
  },
  {
    path: '**',
    redirectTo: ''
  }
];
