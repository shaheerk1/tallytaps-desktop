import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';

import { AppComponent } from './app.component';
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
import { PattiyalWorkspaceComponent } from './supply-receiving/pattiyal-workspace.component';
import { ReportsComponent } from './reports/reports.component';
import { FieldTransactionInboxComponent } from './field-transaction-inbox/field-transaction-inbox.component';
import { BusinessDayComponent } from './business-day/business-day.component';
import { routes } from './app.routes';

@NgModule({
  declarations: [
    AppComponent,
    DashboardComponent,
    BillingComponent,
    RefundComponent,
    CashManagementComponent,
    InvoiceHistoryComponent,
    LoginComponent,
    UserManagementComponent,
    RoleManagementComponent,
    WorkstationManagementComponent,
    ItemManagementComponent,
    PrinterManagementComponent,
    SettingsComponent,
    CustomerAccountsComponent,
    ChequeRegisterComponent,
    SupplyReceivingComponent,
    PattiyalWorkspaceComponent,
    ReportsComponent,
    FieldTransactionInboxComponent,
    BusinessDayComponent
  ],
  imports: [
    BrowserModule,
    FormsModule,
    RouterModule.forRoot(routes)
  ],
  bootstrap: [AppComponent]
})
export class AppModule {}
