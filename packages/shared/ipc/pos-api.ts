export type IpcResult<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: string;
    };

export type ActorContext = {
  id: string;
  permissions: string[];
};

export type FieldInboxConfiguration = {
  configured: boolean;
  hostId: string;
  hasApiKey: boolean;
  updatedAt: string | null;
  apiBaseUrl: string;
};

export type CloudSyncConfiguration = {
  configured: boolean;
  enabled: boolean;
  intervalMinutes: number;
  batchSize: number;
  maxBatchesPerRun: number;
  nickname: string;
  nodeId: string | null;
  pendingCount: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  apiBaseUrl: string;
};

export type MobileInboxBill = {
  id: string; clientBillId: string; catalogPosNodeId: string; deliveryScope: 'all' | 'selected';
  deliveryStatus: 'pending' | 'viewed' | 'printed'; customerName: string | null; customerMobile: string | null;
  note: string | null; subtotal: number; discountTotal: number; taxTotal: number; bagChargeTotal: number;
  wageChargeTotal: number; grandTotal: number; paidTotal: number; balance: number; createdAt: string; receivedAt: string;
  device: { nickname: string | null; name: string | null };
  lines: Array<{ lineNo: number; sourceProductKey: string | null; sku: string | null; barcode: string | null;
    description: string; quantity: number; kilos: number | null; pricingBasis: 'qty' | 'kilos'; unitPrice: number;
    handlingQuantity?: number; measuredQuantity?: number | null; handlingUom?: string; baseUom?: string | null;
    dualUomEnabled?: boolean; requiresMeasuredQuantity?: boolean; allowZeroQuantity?: boolean; quantityStep?: number;
    discount: number; tax: number; merchandiseTotal: number; bagChargeRate?: number; packagingChargeRate?: number;
    bagChargeTotal: number; packagingChargeTotal?: number; wageChargeRate?: number; wageBasis?: 'none' | 'qty' | 'kilos';
    wageChargeTotal: number; lineTotal: number; priceOverrideApplied?: boolean; priceOverrideReason?: string | null;
    productSnapshot?: Record<string, unknown>; attributes: Record<string, unknown> }>;
  payments: Array<{ paymentNo: number; method: string; amount: number; reference: string | null }>;
};

export type FieldInboxMedia = {
  id: string;
  type: string;
  sizeBytes: number;
  contentType: string;
};

export type FieldInboxRecord = {
  id: string;
  clientRecordId: string | null;
  type: string;
  direction: string;
  amount: number;
  item: string | null;
  qty: number | null;
  unit: string | null;
  handling_uom: string;
  base_uom: string | null;
  dual_uom_enabled: number | boolean;
  note: string | null;
  createdAt: string | null;
  receivedAt: string | null;
  media: FieldInboxMedia[];
  device: {
    id: string | null;
    name: string | null;
    model: string | null;
    codeName: string | null;
    nickname: string | null;
    platform: string | null;
    appVersion: string | null;
  };
  resolved: boolean;
  resolvedAt: string | null;
  resolvedBy: number | null;
};

export type FieldInboxRecordList = {
  hostId: string;
  cursor: string;
  range: { since: string; until: string };
  records: FieldInboxRecord[];
};

export type CoreHealth = {
  app: string;
  status: 'ok';
  timestamp: string;
  platform: string;
  electronVersion: string;
  nodeVersion: string;
  registeredPlugins: number;
};

export type DatabaseHealth = {
  status: 'ok';
  databaseTime: string;
};

export type MigrationStatus = {
  database: string;
  total: number;
  executed: number;
  pending: string[];
};

export type MigrationRunResult = {
  database: string;
  batch: number | null;
  executed: string[];
};

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  requiresCore: string;
  dependencies: string[];
  capabilities: string[];
  permissions: string[];
  entry: Record<string, unknown>;
  contributions?: {
    routes?: PluginRouteContribution[];
    menu?: PluginMenuContribution[];
    widgets?: PluginWidgetContribution[];
    settings?: PluginSettingsContribution[];
    reports?: PluginReportContribution[];
  };
  status?: PluginStatus;
};

export type PluginStatus = 'installed' | 'enabled' | 'disabled' | 'failed';

export type PersistedPlugin = {
  id: number;
  pluginId: string;
  name: string;
  version: string;
  status: PluginStatus;
  manifest: PluginManifest;
  installedAt: string;
  enabledAt: string | null;
  disabledAt: string | null;
  updatedAt: string;
};

export type PluginLifecycleLog = {
  plugin_id: string;
  action: string;
  from_status: PluginStatus | null;
  to_status: PluginStatus;
  changed_by: string;
  note: string | null;
  created_at: string;
};

export type PluginLifecycleContext = {
  changedBy?: string;
  note?: string | null;
  actor?: {
    id: string;
    permissions: string[];
  };
};

export type PluginCapability = {
  capability: string;
  granted: number;
  granted_by: string | null;
  granted_at: string | null;
};

export type PluginRouteContribution = {
  path: string;
  title: string;
  requiredPermissions?: string[];
};

export type PluginMenuContribution = {
  id: string;
  label: string;
  route: string;
  order?: number;
  requiredPermissions?: string[];
};

export type PluginWidgetContribution = {
  id: string;
  title: string;
  placement: string;
  icon?: string;
};

export type PluginSettingsContribution = {
  id: string;
  title: string;
  /**
   * Declarative settings form schema rendered on the plugin view page. Values
   * are stored per-plugin via `plugins.settings.*` IPC (the `plugin_settings`
   * table). A plugin backend can re-read them from `services.pluginSettings`.
   */
  schema?: PluginSettingField[];
};

export type PluginReportContribution = {
  id: string;
  title: string;
};

export type PluginFieldType = 'number' | 'text' | 'select' | 'checkbox';

/**
 * A declarative settings-form field type. Optional extensions may use a
 * field-builder for their own settings; SDL authoring is core-owned by
 * Configuration Studio.
 */
export type PluginSettingFieldType = PluginFieldType | 'field-builder';

export type PluginFieldSection =
  | 'billing.header'
  | 'billing.line'
  | 'billing.totals'
  | 'billing.table'
  | 'billing.receipt'
  | 'item.form';

export type PluginFieldFormat = 'text' | 'number' | 'kilos' | 'money';

export type PluginFieldOption = {
  value: string;
  label: string;
};

/**
 * One field of a plugin's settings form. Values are stored in the
 * `plugin_settings` table as JSON keyed by `key` for the plugin.
 */
export type PluginSettingField = {
  key: string;
  label: string;
  type: PluginSettingFieldType;
  options?: PluginFieldOption[];
  default?: unknown;
  required?: boolean;
  placeholder?: string;
  description?: string;
};

/**
 * A user-defined custom field produced by a plugin's `field-builder` widget.
 * `sections` selects which core screens the field is contributed to; the
 * plugin backend converts these into `PluginFieldContribution` entries.
 */
export type PluginCustomFieldDefinition = {
  key: string;
  label?: string;
  type: PluginFieldType;
  sections: PluginFieldSection[];
  required?: boolean;
  order?: number;
  placeholder?: string;
  default?: unknown;
  description?: string;
  options?: PluginFieldOption[];
};

export type PluginSegmentScope = 'bill' | 'billing' | 'item' | 'totals';
export type PluginSegmentKind = 'input' | 'calculated';
export type SdlStorageMode = 'metadata' | 'indexed_attribute' | 'column' | 'child_table';

/**
 * A core SDL segment. Configuration Studio projects these into the standard
 * field sections and evaluates their `equation`s against the line/bill context
 * using the shared Segment Definition Language. `id` is local to the active
 * tenant/store SDL document.
 */
export type PluginSegmentDefinition = {
  id: string;
  label?: string;
  scope?: PluginSegmentScope;
  kind?: PluginSegmentKind;
  type?: PluginFieldType;
  order?: number;
  required?: boolean;
  editable?: boolean;
  placeholder?: string;
  description?: string;
  default?: unknown;
  options?: PluginFieldOption[];
  equation?: string;
  visibleWhen?: string;
  enabledWhen?: string;
  /** Identifies the bill header value used to resolve a receivable customer. */
  purpose?: 'customer_identifier' | 'customer_name';
  affectsLineTotal?: boolean;
  /** Sets the line's gross merchandise amount before discounts, tax and
   *  line adjustments. At most one calculated billing segment may set it. */
  setsLineGross?: boolean;
  /** Whether a calculated billing segment's sum appears in the bill totals
   *  panel. Defaults to true for backwards compatibility. */
  showInTotals?: boolean;
  affectsGrandTotal?: boolean;
  /** Declares where this value belongs operationally. Core validates any
   * relational target; tenant SDL never executes unrestricted DDL. */
  storage?: { mode: SdlStorageMode; target?: string; indexed?: boolean };
  sections?: Array<'billing.header' | 'billing.line' | 'billing.table' | 'billing.receipt' | 'item.form'>;
};

/**
 * A field a plugin contributes to a core screen section.
 *   - billing.header → one transaction-level value entered before item code;
 *                     stored under invoices.metadata.billHeader[pluginId][key]
 *   - billing.line  → rendered in the billing line-entry row; value stored in
 *                     invoice_items.metadata[key]
 *   - billing.totals → aggregate read-only values shown in the bill totals
 *                     panel; `aggregate: 'sum'` sums item.metadata[key] across
 *                     the current bill
 *   - billing.table  → a column in the billing items table; `editable` fields
 *                     are edited inline and persisted back to the line's
 *                     metadata (plugin calculateLine re-runs)
 *   - billing.receipt → per-item detail lines shown on the settled receipt /
 *                     printed receipt for each bill line
 *   - item.form     → rendered in the item master add/edit modal; value stored
 *                     in products.metadata[key]
 * Rendered in ascending `(order, pluginId, key)` order.
 */
export type PluginFieldContribution = {
  key: string;
  /** `bill` fields use transaction metadata; all legacy fields use line/item metadata. */
  scope?: PluginSegmentScope;
  section: PluginFieldSection;
  label: string;
  type: PluginFieldType;
  purpose?: 'customer_identifier' | 'customer_name';
  options?: PluginFieldOption[];
  order?: number;
  /**
   * For billing.line / billing.table fields: the field is only shown when the
   * selected product's metadata property at this key is truthy (e.g. "per_kilo").
   */
  visibleWhen?: string;
  /**
   * For billing.line fields: the field must hold a non-empty value before the
   * line can be added (e.g. produce-market's per-kilo weight). Validated on
   * the billing screen and again by plugin finalize hooks.
   */
  required?: boolean;
  /**
   * For billing.table fields: whether the column can be edited inline on an
   * existing bill line. Defaults to false (read-only display).
   */
  editable?: boolean;
  /**
   * Optional display/parse formatting for table columns and receipt lines.
   */
  format?: PluginFieldFormat;
  showInTable?: boolean;
  aggregate?: 'sum';
  /**
   * Default value applied when a billing.line / item.form field is shown but
   * the product (or line) has no stored value for this key yet. Enables
   * plugins to seed inputs instead of requiring the operator to type them.
   */
  default?: unknown;
  /**
   * Placeholder text for text/number inputs.
   */
  placeholder?: string;
  /**
   * Short helper text shown under the input.
   */
  description?: string;
};

export type PluginField = { pluginId: string } & PluginFieldContribution;

export type ExtensionSnapshot = {
  routes: Array<{ pluginId: string } & PluginRouteContribution>;
  menu: Array<{ pluginId: string } & PluginMenuContribution>;
  widgets: Array<{ pluginId: string } & PluginWidgetContribution>;
  settings: Array<{ pluginId: string } & PluginSettingsContribution>;
  reports: Array<{ pluginId: string } & PluginReportContribution>;
  fields: PluginField[];
};

export type DiscoveredPlugin = {
  folder: string;
  path: string;
  manifest: PluginManifest;
  persisted: PersistedPlugin;
};

export type InvalidPlugin = {
  folder: string;
  path: string;
  errors: string[];
};

export type PluginDiscoveryResult = {
  pluginsDir: string;
  discovered: DiscoveredPlugin[];
  invalid: InvalidPlugin[];
  summary: {
    totalFolders: number;
    validPlugins: number;
    invalidPlugins: number;
  };
};

export type LoadEnabledResult = {
  loaded: string[];
  total: number;
};

export type PluginMigrationStatus = {
  pluginId: string;
  total: number;
  executed: string[];
  pending: string[];
};

export type PluginMigrationRunResult = {
  pluginId: string;
  batch: number | null;
  executed: string[];
  total: number;
};

export type UninstallResult = {
  pluginId: string;
  uninstalled: boolean;
  dataRemoved: boolean;
};

export type AuthUser = {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  lastLoginAt: string | null;
  permissions: string[];
  roles: Array<{ key: string; name: string }>;
};

export type WorkstationSession = {
  sessionId: number;
  workstationId: number;
  locationCode: string;
  machineCode: string;
  workstationName: string;
  billingDate: string;
  openingBalance: number;
  currentReceiptNo: number;
  workstationSettings: Record<string, unknown>;
  status: 'open' | 'closed';
  openedAt?: string;
};

export type BusinessDay = {
  id: number;
  locationCode: string;
  businessDate: string;
  status: 'open' | 'closing' | 'closed';
  openedBy: number | null;
  openedByName: string | null;
  openedAt: string;
  closingStartedBy: number | null;
  closingStartedAt: string | null;
  closedBy: number | null;
  closedByName: string | null;
  closedAt: string | null;
  closeReason: string;
  reopenCount: number;
  summarySnapshot: BusinessDaySummary | null;
};

export type BusinessDaySummary = {
  invoiceCount: number;
  merchandiseTotal: number;
  bagChargeTotal: number;
  wageChargeTotal: number;
  salesTotal: number;
  paidTotal: number;
  collectionTotal: number;
  creditTotal: number;
  refundCount: number;
  refundTotal: number;
  refundPayoutTotal: number;
  shiftCount: number;
  closedShiftCount: number;
  varianceTotal: number;
  cashNet: number;
  cashMovements: Array<{ type: string; direction: 'in' | 'out'; amount: number }>;
  tenderBreakdown: Array<{ method: string; documentType: string; amount: number }>;
};

export type BusinessDayState = {
  day: BusinessDay | null;
  lastClosedDay: BusinessDay | null;
  blockers: Array<{ key: string; label: string; count: number; detailCount?: number; action: string }>;
  summary: BusinessDaySummary | null;
  events: Array<{
    id: number; eventNo: number; eventType: string; fromStatus: string | null; toStatus: string | null;
    reason: string; details: unknown; createdAt: string; userId: number | null; userName: string;
  }>;
};

export type BillConfig = {
  headers?: { line1?: string; line2?: string; line3?: string };
  footers?: { line1?: string; line2?: string };
  storeAddress?: { line1?: string; line2?: string; phone?: string; fax?: string };
  logo?: { path?: string };
};

export type Workstation = {
  id: number;
  location_code: string;
  machine_code: string;
  name: string;
  status: string;
  created_at: string;
};

export type ManageUser = {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  last_login_at: string | null;
  password_updated_at: string | null;
  created_at: string;
  updated_at: string;
  roles: Array<{ id: number; role_key: string; name: string }>;
};

export type ManageUserDetail = ManageUser & {
  permissions: Array<{ permission_key: string; name: string }>;
};

export type ManageRole = {
  id: number;
  role_key: string;
  name: string;
  created_at: string;
  permissionCount: number;
  userCount: number;
};

export type ManageRoleDetail = ManageRole & {
  permissions: Array<{ id: number; permission_key: string; name: string }>;
  users: Array<{ id: number; username: string; display_name: string }>;
};

export type ManagePermission = {
  id: number;
  permission_key: string;
  name: string;
};

export type PriorityList = {
  id: number;
  name: string;
  isDefault: boolean;
  entries: string[];
  assignments: Array<{ targetType: 'role' | 'user'; targetId: number }>;
};

export type PriorityListAssignmentTarget = {
  id: number;
  username: string;
  displayName: string;
} | {
  id: number;
  roleKey: string;
  name: string;
};

export type UiPreferences = {
  autoHide: boolean;
  autoCloseSeconds: number;
  /** Which screen edge the sidebar docks to. */
  position: 'left' | 'right';
  /** Native window mode applied before the login screen is loaded. */
  startupWindowMode: 'normal' | 'maximized' | 'fullscreen';
};

export type PlatformConfigSnapshot = {
  schemaVersion: number;
  rebuildMode: 'bounded' | 'open';
  sdlMode: 'compiled';
  sdlEffectAreas: Array<'field-rendering' | 'input-validation' | 'receipt-layout' | 'line-calculation' | 'bill-calculation'>;
  allowRuntimePluginOverrides: boolean;
  preferRelationalForOperationalData: boolean;
  metadataPolicy: 'optional-only' | 'mixed';
  activeVerticalPack: string | null;
  notes: string;
};

export type SdlCompiledSnapshot = {
  schemaVersion: number;
  source: { owner: string; settingsKey: string };
  compiledAt: string;
  effectAreas: PlatformConfigSnapshot['sdlEffectAreas'];
  validation: { valid: boolean; errors: string[]; warnings: string[] };
  segments: PluginSegmentDefinition[];
  storagePlan?: {
    version: number;
    fields: Array<{ id: string; scope: string; kind: string; type: string; storage: { mode: SdlStorageMode; target: string; indexed: boolean; source: string } }>;
    relationalTargets: Array<{ target: string; segmentId: string; scope: string }>;
    deferredStructures: Array<{ mode: SdlStorageMode; target: string; segmentId: string; scope: string }>;
  };
  storageApplication?: {
    status: 'applied' | 'blocked' | 'pending_review';
    errorMessage: string | null;
  };
};

export type SdlDocument = {
  id: number;
  tenantKey: string;
  storeCode: string;
  sourceVersion: number;
  checksum: string;
  source: { schemaVersion: number; segments: PluginSegmentDefinition[] };
  importedFrom: string | null;
  updatedBy: number | null;
  updatedAt: string;
};

export type SdlTemplate = {
  id: number;
  name: string;
  source: SdlDocument['source'];
};

export type LoginResult = {
  user: AuthUser;
  token: string;
  expiresAt: string;
  workstationSession?: WorkstationSession | null;
  workstationWarning?: string | null;
};

export type SessionResult = {
  user: AuthUser;
  token: string;
  expiresAt: string;
  workstationSession?: WorkstationSession | null;
};

export type BillContext = {
  sessionId: number;
  receiptNo?: number;
  locationCode: string;
  machineCode: string;
  billingDate: string;
  userId?: number;
  customerCode?: string;
  customerAccountId?: number | null;
};

export type BillItem = {
  id?: number;
  sessionId?: number;
  receiptNo?: number;
  seqNo?: number;
  productId?: number | null;
  customerCode?: string;
  customerAccountId?: number | null;
  supplierCode?: string;
  itemCode: string;
  description: string;
  qty: number;
  kilos?: number | null;
  handlingUom?: string;
  baseUom?: string | null;
  allocationPriorityLotId?: number | null;
  allocationPriorityLotCode?: string | null;
  allocationPrioritySource?: 'automatic' | 'remembered' | 'manual' | null;
  requiresKilos?: number | boolean;
  pricingBasis?: 'qty' | 'kilos';
  quantityStep?: number;
  allowZeroQuantity?: number | boolean;
  unitPrice: number;
  discount: number;
  tax?: number;
  merchandiseTotal?: number;
  bagChargeRate?: number;
  bagChargeTotal?: number;
  wageChargeRate?: number;
  wageBasis?: 'none' | 'qty' | 'kilos';
  wageChargeTotal?: number;
  total: number;
  metadata?: Record<string, unknown>;
};

export type InvoiceArchive = {
  id: number;
  invoice_number: string;
  loc_code: string;
  mac_code: string;
  receipt_no: number;
  txn_date: string;
  status: string;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  paidTotal: number;
  balance: number;
  customer_code?: string;
  bagChargeTotal?: number;
  wageChargeTotal?: number;
  metadata: Record<string, unknown>;
  billHeader?: Record<string, Record<string, unknown>>;
  customer?: { id: number; customerCode: string | null; name: string; outstandingBalance: number } | null;
  items: Array<{
    id: number;
    item_code: string;
    description: string;
    qty: number;
    kilos?: number | null;
    handling_uom_snapshot?: string | null;
    base_uom_snapshot?: string | null;
    pricingBasis?: 'qty' | 'kilos';
    unitPrice: number;
    discount: number;
    tax: number;
    supplier_code?: string;
    merchandiseTotal?: number;
    bagChargeTotal?: number;
    wageChargeTotal?: number;
    total: number;
    metadata: Record<string, unknown>;
  }>;
  payments: PaymentLine[];
};

export type OpenBillResult = {
  sessionId: number;
  receiptNo: number;
  locCode: string;
  macCode: string;
  txnDate: string;
  userId?: number;
  items: BillItem[];
  customerCode?: string;
  customerAccountId?: number | null;
  billHeader?: Record<string, Record<string, unknown>>;
};

export type HeldBill = {
  receiptNo: number;
  sessionId: number;
  userId: number;
  created_at: string;
  customerCode?: string | null;
  customerAccountId?: number | null;
  itemCount: number;
  grossAmt: number;
  discountTotal: number;
  netAmt: number;
};

export type PaymentMode = {
  id: string;
  name: string;
  icon: string;
  type: 'tender' | 'credit';
  priority: number;
  enabled?: boolean;
  pluginId?: string | null;
  core?: boolean;
  configuration?: Record<string, unknown> | null;
};

export type CustomerAdvanceSummary = {
  customer: { id: number; accountNumber: string; name: string; mobile: string | null };
  locationCode: string;
  availableBalance: number;
  receipts: Array<{ id: number; advanceNumber: string; date: string; originalAmount: number; remainingAmount: number; reason: string; createdAt: string }>;
  entries: Array<{ id: number; advanceReceiptId: number; advanceNumber: string; type: string; amount: number; reason: string; date: string; invoiceId: number | null; metadata: Record<string, unknown>; userName: string; createdAt: string }>;
};

export type FundKind = 'pos_drawer' | 'cash_safe' | 'bank' | 'stakeholder';

/**
 * A named place money sits. A `pos_drawer` fund mirrors a real till, so its
 * balance is what the open shift holds; every other kind keeps its own ledger.
 */
export type FundAccount = {
  id: number;
  fundCode: string;
  name: string;
  fundKind: FundKind;
  cashDrawerId: number | null;
  locationCode: string;
  currencyCode: string;
  openingBalance: number;
  holderName: string | null;
  accountReference: string | null;
  notes: string | null;
  isActive: boolean;
  sortOrder: number;
  balance: number;
  lastMovementAt: string | null;
  metadata: Record<string, unknown>;
};

export type FundMovement = {
  id: number;
  direction: 'in' | 'out';
  amount: number;
  reason: string;
  kind: string;
  date: string;
  userName: string;
  createdAt: string;
};

export type ExpenseTreatment = 'lot_cost' | 'overhead' | 'supplier_deduction';

export type ExpenseCategory = {
  id: number;
  categoryCode: string;
  name: string;
  defaultTreatment: ExpenseTreatment;
  helpText: string | null;
  isActive: boolean;
  sortOrder: number;
};

export type ExpenseEntry = {
  id: number;
  expenseNumber: string;
  date: string;
  amount: number;
  payee: string | null;
  reference: string | null;
  reason: string;
  status: 'recorded' | 'void';
  allocationTarget: 'none' | 'lot' | 'goods_receipt';
  allocatedTotal: number;
  unallocatedTotal: number;
  goodsReceiptId: number | null;
  grnNumber: string | null;
  stakeholderName: string | null;
  categoryId: number;
  categoryName: string;
  categoryTreatment: ExpenseTreatment;
  fundAccountId: number;
  fundName: string;
  fundKind: FundKind;
  locationCode: string;
  machineCode: string;
  userName: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type ExpenseRegister = {
  rows: ExpenseEntry[];
  total: number;
  goodsTotal: number;
  overheadTotal: number;
  attachedTotal: number;
  unattachedTotal: number;
  byCategory: Array<{ id: number; name: string; treatment: ExpenseTreatment; entryCount: number; total: number }>;
  byFund: Array<{ id: number; name: string; fundKind: FundKind; entryCount: number; total: number }>;
};

export type StakeholderMovementInput = {
  stakeholderId: number;
  fundAccountId: number;
  amount: number;
  reason: string;
  userId: number;
  overrideApprovedBy?: number | null;
  overrideReason?: string;
  origin: { locCode: string; macCode: string; txnDate: string };
};

export type StakeholderMovementResult = {
  entryNumber: string; amount: number; stakeholderName: string;
  fundName: string; claim: number; overrideUsed: boolean;
  capitalBalance: number; repayableBalance: number; profitBalance: number; availableToDraw: number;
};

export type CostedLot = {
  id: number;
  lotCode: string;
  grnNumber: string | null;
  goodsReceiptId: number | null;
  date: string;
  productId: number;
  productName: string;
  sku: string;
  supplierId: number;
  supplierName: string;
  ownershipModel: 'owned' | 'consignment';
  receivedHandlingQuantity: number;
  remainingHandlingQuantity: number;
  receivedBaseQuantity: number | null;
  handlingUom: string;
  baseUom: string | null;
  purchaseCostTotal: number;
  allocatedCostTotal: number;
  landedCostTotal: number;
  recognizedCost: number;
  remainingCost: number;
};

export type RecurringExpense = {
  id: number;
  locationCode: string;
  name: string;
  expenseCategoryId: number;
  categoryName: string;
  fundAccountId: number;
  fundName: string;
  amount: number;
  payee: string;
  reference: string;
  reason: string;
  cadence: 'weekly' | 'monthly' | 'yearly' | 'custom_days';
  intervalCount: number;
  nextDueDate: string;
  endDate: string | null;
  isActive: boolean;
  lastExpenseNumber: string | null;
  lastRecordedAt: string | null;
};

export type AllocationBasis = 'direct' | 'base_quantity' | 'handling_quantity' | 'sale_value' | 'equal';

/** One lot's real cost and what it actually made. */
export type LotProfitRow = {
  id: number;
  lotCode: string;
  grnNumber: string | null;
  date: string;
  productName: string;
  sku: string;
  supplierId: number;
  supplierName: string;
  ownershipModel: 'owned' | 'consignment';
  handlingUom: string;
  baseUom: string | null;
  receivedHandlingQuantity: number;
  receivedBaseQuantity: number | null;
  remainingHandlingQuantity: number;
  soldHandlingQuantity: number;
  soldBaseQuantity: number;
  saleValue: number;
  purchaseCost: number;
  allocatedCost: number;
  supplierDue: number;
  landedCostTotal: number;
  recognizedCost: number;
  remainingCost: number;
  landedCostPerHandling: number | null;
  landedCostPerBase: number | null;
  margin: number;
  marginPercent: number | null;
  fullySold: boolean;
};

export type LotProfitability = {
  lots: LotProfitRow[];
  totals: {
    saleValue: number; purchaseCost: number; allocatedCost: number;
    supplierDue: number; landedCostTotal: number; recognizedCost: number; remainingCost: number; margin: number;
  };
};

export type LotCostAllocation = {
  id: number;
  expenseEntryId: number;
  expenseNumber: string;
  categoryName: string;
  payee: string | null;
  documentType: 'expense' | 'reallocation';
  basis: AllocationBasis;
  basisValue: number | null;
  amount: number;
  reason: string;
  date: string;
  userName: string;
};

export type Stakeholder = {
  id: number;
  stakeholderCode: string;
  displayName: string;
  stakeholderType: 'owner' | 'partner' | 'investor';
  fundAccountId: number | null;
  fundName: string | null;
  borneCostTreatment: 'capital' | 'liability';
  locationCode: string;
  mobile: string | null;
  notes: string | null;
  isActive: boolean;
  sortOrder: number;
  contributed: number;
  borne: number;
  profitShare: number;
  drawn: number;
  settled: number;
  capitalBalance: number;
  repayableBalance: number;
  profitBalance: number;
  drawingsBalance: number;
  availableToDraw: number;
  totalInterest: number;
  claim: number;
  businessSharePercent: number | null;
};

export type StakeholderEntry = {
  id: number;
  entryNumber: string;
  date: string;
  entryType: 'capital_contribution' | 'expense_borne' | 'drawing' | 'profit_share_allocation' | 'settlement';
  balanceBucket: 'capital' | 'repayable' | 'profit' | 'drawing';
  amount: number;
  fundName: string | null;
  lotCode: string | null;
  reason: string;
  overrideApprover: string | null;
  overrideReason: string | null;
  userName: string;
};

export type StakeholderShare = {
  id: number;
  stakeholderId: number;
  stakeholderName: string;
  scope: 'business' | 'lot';
  inventoryLotId: number | null;
  lotCode: string | null;
  sharePercent: number;
  effectiveFrom: string;
  notes: string | null;
};

export type LedgerAccount = {
  id: number;
  accountCode: string;
  name: string;
  accountType: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  normalBalance: 'debit' | 'credit';
  description: string | null;
};

export type JournalEntry = {
  id: number;
  journalNumber: string;
  date: string;
  narration: string;
  sourceType: string;
  sourceId: string;
  totalDebit: number;
  totalCredit: number;
  userName: string;
  lines: Array<{
    lineNo: number; accountCode: string; accountName: string;
    accountType: string; debit: number; credit: number; memo: string | null;
  }>;
};

export type TrialBalanceRow = {
  accountCode: string; name: string; accountType: string;
  normalBalance: 'debit' | 'credit'; debitTotal: number; creditTotal: number; balance: number;
};

export type TrialBalance = {
  accounts: TrialBalanceRow[];
  totalDebit: number; totalCredit: number; difference: number; inBalance: boolean;
};

export type AccountingPeriod = {
  id: number; locationCode: string; periodStart: string; periodEnd: string;
  status: 'open' | 'closed'; closedByName: string | null; closedAt: string | null;
  reopenCount: number; notes: string | null;
};

export type InventoryLotCandidate = {
  id: number;
  lot_code: string;
  txn_date: string;
  grn_no: number;
  line_no: number;
  grn_number: string;
  external_reference?: string | null;
  supplier_code?: string | null;
  supplier_name: string;
  received_handling_quantity: number;
  remaining_handling_quantity: number;
  received_base_quantity?: number | null;
  remaining_base_quantity?: number | null;
  handling_uom_snapshot: string;
  base_uom_snapshot?: string | null;
  conversion_mode: 'fixed' | 'variable';
  actual_base_per_handling?: number | null;
  ownership_model?: string | null;
  remembered: boolean;
  priority: number;
  priority_reason: 'remembered' | 'fifo';
};

export type ChequePaymentDetails = {
  number?: string | null;
  date?: string | null;
  bankName?: string | null;
  branchName?: string | null;
  drawerName?: string | null;
  drawerPartyId?: number | null;
  accountReference?: string | null;
  notes?: string | null;
};

export type PaymentLine = {
  method: string;
  amount: number;
  fundAccountId?: number | null;
  providerRef?: string | null;
  /** Present only when the tender was received by cheque. */
  chequeDetails?: ChequePaymentDetails | null;
  type?: 'tender' | 'credit';
};

export type FinalizeResult = {
  invoiceId: number;
  invoiceNumber: string;
  receiptNo: number;
  status: 'paid' | 'partial' | 'draft';
  grandTotal: number;
  paidTotal: number;
  creditTotal: number;
  balance: number;
  cashAmt: number;
  changeAmt: number;
  nextReceiptNo: number;
};

export type RefundSourceItem = {
  id: number;
  seqNo: number;
  productId: number | null;
  itemCode: string;
  description: string;
  qty: number;
  kilos: number | null;
  handlingUom?: string;
  baseUom?: string | null;
  unitPrice: number;
  discount: number;
  tax: number;
  supplierCode?: string;
  merchandiseTotal: number;
  bagChargeTotal: number;
  wageChargeTotal: number;
  total: number;
  metadata: Record<string, unknown>;
  refundedQuantity: number;
  refundedKilos: number;
  refundedTotal: number;
  refundedBagChargeTotal: number;
  refundedWageChargeTotal: number;
  remainingQuantity: number;
  remainingKilos: number | null;
  remainingTotal: number;
  remainingBagChargeTotal: number;
  remainingWageChargeTotal: number;
};

export type RefundSourceInvoice = {
  id: number;
  invoice_number: string;
  loc_code: string;
  mac_code: string;
  receipt_no: number;
  txn_date: string;
  status: 'paid' | 'partial';
  grandTotal: number;
  paidTotal: number;
  balance: number;
  advanceRestorable: number;
  customer_code?: string;
  bagChargeTotal?: number;
  wageChargeTotal?: number;
  metadata: Record<string, unknown>;
  billHeader?: Record<string, Record<string, unknown>>;
  customer?: { id: number; customerCode: string | null; name: string; outstandingBalance: number } | null;
  payments: Array<{ method: string; amount: number; providerRef?: string | null; status: string }>;
  items: RefundSourceItem[];
};

export type RefundDraftItem = {
  id?: number;
  source_invoice_item_id: number;
  product_id: number | null;
  supplier_code?: string;
  item_code: string;
  description: string;
  sourceQuantity: number;
  sourceKilos: number | null;
  returnQuantity: number;
  returnKilos: number | null;
  handlingUom?: string;
  baseUom?: string | null;
  unitPrice: number;
  discount: number;
  tax: number;
  sourceMerchandiseTotal: number;
  sourceBagChargeTotal: number;
  sourceWageChargeTotal: number;
  merchandiseTotal: number;
  bagChargeMode: 'proportional' | 'exclude' | 'custom';
  bagChargeTotal: number;
  wageChargeMode: 'proportional' | 'exclude' | 'custom';
  wageChargeTotal: number;
  total: number;
  stock_disposition: 'sellable' | 'damaged' | 'waste';
  metadata: Record<string, unknown>;
};

export type RefundDraft = {
  id: number;
  source_invoice_id: number;
  source_invoice_number: string;
  refundNo: number;
  status: 'open' | 'held' | 'abandoned' | 'completed';
  reason: string | null;
  loc_code: string;
  mac_code: string;
  txn_date: string;
  items: RefundDraftItem[];
};

export type RefundActiveDraft = {
  id: number;
  refundNo: number;
  status: 'open' | 'held';
  reason: string | null;
  userId: number | null;
  createdAt: string;
  updatedAt: string;
  sourceInvoiceNumber: string;
  itemCount: number;
  grandTotal: number;
};

export type RefundFinalizeResult = {
  refundId: number;
  refundNumber: string;
  refundNo: number;
  grandTotal: number;
  paidTotal: number;
  debtReduction?: number;
  payoutDue?: number;
};

export type CashCountLine = {
  denomination: number;
  quantity: number;
  lineTotal?: number;
};

export type CashMovement = {
  id: number;
  movement_type: string;
  direction: 'in' | 'out';
  amount: number;
  reason: string | null;
  created_at: string;
  reference_type?: string | null;
  reference_id?: string | null;
  editable?: boolean;
};

export type CashMovementHistoryRow = {
  id: number;
  movementType: string;
  direction: 'in' | 'out';
  amount: number;
  status: 'active' | 'void';
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  cashShiftId: number;
  businessDate: string;
  shiftNo: number;
  machineCode: string;
  createdByName: string;
  voidedByName: string | null;
  editable: boolean;
};

export type CashShiftReportPrint = {
  id: number;
  cashShiftReportId: number | null;
  cashShiftId: number;
  reportType: 'X' | 'Z';
  reportNo: number;
  snapshot: Record<string, unknown>;
  printedAt: string;
  createdAt: string;
  printedBy: number;
  printedByName: string;
};

export type CashShift = {
  id: number;
  drawerId: number;
  drawerName: string;
  workstationSessionId: number;
  businessDate: string;
  status: 'open' | 'blind_closed' | 'closed';
  currencyCode: string;
  openingTotal: number;
  expectedTotal: number;
  declaredTotal: number | null;
  varianceTotal: number | null;
  varianceReason: string | null;
  movements: CashMovement[];
  counts: Array<{ id: number; count_type: 'opening' | 'closing'; total: number; lines: CashCountLine[] }>;
};

/** Authoritative bill totals computed by the billing engine (includes plugin
 *  totals-segment adjustments via the grand-total hooks). */
export type BillTotals = {
  grossTotal: number;
  discountTotal: number;
  netTotal: number;
  grandTotal: number;
  totals: Record<string, number>;
};

export type CatalogProduct = {
  id: number;
  sku: string;
  name: string;
  barcode: string | null;
  category: string | null;
  unit: string | null;
  handling_uom: string;
  base_uom: string | null;
  dual_uom_enabled: number | boolean;
  requires_kilos: number | boolean;
  pricing_basis: 'qty' | 'kilos';
  quantity_step: number;
  allow_zero_quantity: number | boolean;
  unit_price: number;
  bag_charge: number;
  wage_charge: number;
  wage_basis: 'none' | 'qty' | 'kilos';
  price_override_allowed: number | boolean;
  minimum_sell_price: number | null;
  maximum_sell_price: number | null;
  price_override_reason_required: number | boolean;
  stock_qty: number;
  stock_handling_qty: number;
  stock_base_qty: number;
  is_active: number | boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type CatalogProductInput = {
  sku: string;
  name: string;
  unitPrice: number;
  stockQty?: number;
  barcode?: string | null;
  category?: string | null;
  unit?: string | null;
  handlingUom?: string;
  baseUom?: string | null;
  dualUomEnabled?: boolean;
  requiresKilos?: boolean;
  pricingBasis?: 'qty' | 'kilos';
  quantityStep?: number;
  allowZeroQuantity?: boolean;
  bagCharge?: number;
  wageCharge?: number;
  wageBasis?: 'none' | 'qty' | 'kilos';
  priceOverrideAllowed?: boolean;
  minimumSellPrice?: number | null;
  maximumSellPrice?: number | null;
  priceOverrideReasonRequired?: boolean;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
};

// ── Printing ──────────────────────────────────────────────

export type PrinterDevice = {
  id: string;
  name: string;
  vendorId?: number;
  productId?: number;
  isDefault: boolean;
};

export type PrintTextLine = {
  text: string;
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  size?: number; // 0 = normal, 1 = double height/width, 2 = 2x2
  /** Values that share one emphasized header row (for example tagline and customer code). */
  identity?: { left: string; right: string };
};

export type PrintDocItem = {
  description: string;
  qty?: string;
  amount?: string;
  extras?: Array<{ label: string; value: string }>;
  /** Structured invoice measures for the dedicated DDEC thermal receipt layout. */
  measure?: {
    qty: string;
    kilos?: string;
    rate: string;
  };
};

export type PrintBrand = {
  name?: string;
  tagline?: string;
  addressLines?: string[];
  phone?: string;
};

export type ReceiptLanguage = 'en-LK' | 'si-LK' | 'ta-LK';

export type ReceiptLabels = {
  item: string; qty: string; kg: string; rate: string; amount: string;
  qtyTotal: string; subtotal: string; bagCharge: string; wageCharge: string;
  discount: string; total: string; receipt: string; invoice: string; date: string;
  terminal: string; cashier: string; customer: string; document: string; original: string;
  refund: string; refundTotal: string; cash: string; card: string; cheque: string; change: string;
  pendingBalance: string; phone: string; salesReport: string; period: string;
  lines: string; order: string;
};

/** Public, display-safe store details used to render customer receipts. */
export type ReceiptPrintSettings = {
  storeName: string;
  tagline: string;
  addressLines: string[];
  phone: string;
  headers: string[];
  footers: string[];
  currencySymbol: string;
  dateFormat: string;
  logoDataUrl: string;
  language: ReceiptLanguage;
  labels: ReceiptLabels;
};

export type PattiyalStatus = 'draft' | 'reviewed' | 'finalized' | 'void';
export type PattiyalCandidate = {
  invoiceItemId: number; invoiceId: number; invoiceNumber: string; locCode: string; macCode: string;
  txnDate: string; receiptNo: number; seqNo: number; txnTime: string; customerCode: string;
  productId: number | null; itemCode: string; description: string; sourceSupplierCode: string;
  sourceSupplierId: number | null; effectiveSupplierId: number | null; effectiveSupplierCode: string;
  effectiveSupplierName: string; attributionId: number | null; attributionReason: string;
  pricingBasis: 'qty' | 'kilos'; unitPrice: number; sourceQuantity: number; sourceKilos: number | null;
  sourceMerchandise: number; sourceBagCharge: number; sourceWageCharge: number;
  refundedQuantity: number; refundedKilos: number; refundedMerchandise: number;
  netQuantity: number; netKilos: number | null; netMerchandise: number;
  availableQuantity: number; availableKilos: number | null; availableMerchandise: number;
  availableRefund: number; availableBagCharge: number; availableWageCharge: number;
  committedQuantity: number; committedKilos: number; committedMerchandise: number;
  committedStatementNumbers: string;
  draftQuantity: number; draftKilos: number; draftMerchandise: number; draftStatementCount: number;
};

export type PattiyalDraftInput = {
  statementId?: number | null; supplierId: number; fromDate: string; toDate: string;
  locCode: string; macCode: string; txnDate: string; userId?: number | null;
  commissionRate: number; commissionRounding: 'cents' | 'nearest_rupee' | 'floor_rupee' | 'ceil_rupee' | 'manual';
  commissionOverride?: number | null; commissionOverrideReason?: string; notes?: string;
  grnIds: number[];
  allocations: Array<{ invoiceItemId: number; allocatedQuantity: number; allocatedKilos?: number | null; merchandiseAmount?: number; bagChargeAmount?: number; wageChargeAmount?: number; attributionReason?: string; note?: string }>;
  manualLines: Array<{ productId?: number | null; itemCode: string; description: string; pricingBasis: 'qty' | 'kilos'; unitPrice: number; quantity: number; kilos?: number | null; merchandiseAmount?: number; reason: string }>;
  adjustments: Array<{ adjustmentType: 'deduction' | 'credit'; label: string; amount: number; note?: string }>;
};

export type PattiyalDetail = {
  statement: Record<string, any>;
  allocations: Array<Record<string, any>>;
  manualLines: Array<Record<string, any>>;
  adjustments: Array<Record<string, any>>;
  grns: Array<Record<string, any>>;
  groupedLines: Array<Record<string, any>>;
  reconciliation: Array<Record<string, any>>;
  events: Array<Record<string, any>>;
};

export type PrintDocument = {
  /** A4 document title. Thermal printing can ignore this value. */
  documentTitle?: string;
  /** Legacy receipt title lines, retained for existing callers. */
  headerLines?: string[];
  /** Store identity rendered in the branded receipt masthead. */
  brand?: PrintBrand;
  /** Optional compact data-URL logo rendered above the receipt masthead. */
  logoDataUrl?: string;
  addressLines?: string[];
  /** Optional layout header lines rendered below the brand/contact block. */
  secondaryHeaderLines?: PrintTextLine[];
  /** Key/value meta rows (receipt no, date, terminal, cashier...). */
  meta?: Array<{ label: string; value: string; /** Translate a fixed meta value such as REFUND. */ translateValue?: boolean }>;
  /** Free-form lines rendered before the items table. */
  preLines?: PrintTextLine[];
  /** Dedicated invoice layout: item description then Qty / Kg / Rate / Amount. */
  itemLayout?: 'standard' | 'invoice-measures';
  /** Selected customer-facing thermal receipt language. */
  receiptLanguage?: ReceiptLanguage;
  /** Optional Unicode-raster header treatment for billing receipts only. */
  rasterHeaderLayout?: 'standard' | 'billing';
  /** Quantity shown in place of the first Subtotal label on invoice-style receipts. */
  quantityTotal?: string;
  /** Narrow receipt-style PDF used only for archived thermal receipt copies. */
  pdfLayout?: 'standard' | 'thermal-receipt' | 'supplier-sales-statement';
  /** Optional measure summary for structured supplier sales statement PDFs. */
  statementSummary?: { quantityTotal: string; kilosTotal: string };
  items: PrintDocItem[];
  /** Total rows shown under the items (grand total, wage, bags...). */
  totals: Array<{ label: string; value: string; bold?: boolean }>;
  footerLines?: string[];
  /** Optional numeric receipt barcode rendered as EAN-13 near the bottom. */
  barcode?: string;
  /** Optional receipt payload rendered as a raster QR image for broad printer compatibility. */
  qrCode?: string;
  /** Cut the paper after printing. Defaults to true. */
  cut?: boolean;
};

export type PrintResult = {
  success: boolean;
  printerId?: string;
  printerName?: string;
  message?: string;
  error?: string;
};

export interface PosApi {
  auth: {
    login: (payload: {
      username: string;
      password: string;
      billingDate?: string;
      workstationId?: number;
      openingBalance?: number;
    }) => Promise<IpcResult<LoginResult>>;
    validateSession: (token: string) => Promise<IpcResult<SessionResult>>;
    logout: (token: string) => Promise<IpcResult<{ loggedOut: boolean }>>;
    cleanup: () => Promise<IpcResult<{ deleted: number }>>;
  };
  workstations: {
    list: () => Promise<IpcResult<Workstation[]>>;
    listAll: (actor?: ActorContext | null) => Promise<IpcResult<Workstation[]>>;
    create: (payload: {
      locationCode: string;
      machineCode: string;
      name: string;
      status?: string;
    }, actor?: ActorContext | null) => Promise<IpcResult<Workstation>>;
    update: (id: number, payload: {
      name?: string;
      status?: string;
    }, actor?: ActorContext | null) => Promise<IpcResult<Workstation>>;
    delete: (id: number, actor?: ActorContext | null) => Promise<IpcResult<{ deleted: boolean }>>;
    activeSession: (userId: number) => Promise<IpcResult<WorkstationSession | null>>;
    openSession: (payload: {
      userId: number;
      workstationId?: number;
      billingDate?: string;
      openingBalance?: number;
    }) => Promise<IpcResult<WorkstationSession>>;
    closeSession: (userId: number) => Promise<IpcResult<{ closed: boolean }>>;
    updateSessionDate: (
      userId: number,
      billingDate: string,
      actor?: ActorContext | null
    ) => Promise<IpcResult<WorkstationSession | null>>;
  };
  core: {
    healthCheck: () => Promise<IpcResult<CoreHealth>>;
  };
  database: {
    healthCheck: () => Promise<IpcResult<DatabaseHealth>>;
    migrationStatus: () => Promise<IpcResult<MigrationStatus>>;
    runPendingMigrations: () => Promise<IpcResult<MigrationRunResult>>;
  };
  plugins: {
    discover: () => Promise<IpcResult<PluginDiscoveryResult>>;
    list: () => Promise<IpcResult<PluginManifest[]>>;
    persistedList: () => Promise<IpcResult<PersistedPlugin[]>>;
    loadEnabled: () => Promise<IpcResult<LoadEnabledResult>>;
    enable: (pluginId: string, context?: PluginLifecycleContext) => Promise<IpcResult<PersistedPlugin>>;
    disable: (pluginId: string, context?: PluginLifecycleContext) => Promise<IpcResult<PersistedPlugin>>;
    retry: (pluginId: string, context?: PluginLifecycleContext) => Promise<IpcResult<PersistedPlugin>>;
    uninstall: (
      pluginId: string,
      options?: { removeData?: boolean; changedBy?: string; note?: string | null; actor?: { id: string; permissions: string[] } }
    ) => Promise<IpcResult<UninstallResult>>;
    lifecycleLogs: (pluginId?: string | null) => Promise<IpcResult<PluginLifecycleLog[]>>;
    capabilityList: (
      pluginId: string,
      context?: PluginLifecycleContext
    ) => Promise<IpcResult<PluginCapability[]>>;
    invoke: (pluginId: string, channel: string, payload?: unknown) => Promise<IpcResult<unknown>>;
    migrations: {
      status: (pluginId: string) => Promise<IpcResult<PluginMigrationStatus>>;
      run: (pluginId: string, actor?: string) => Promise<IpcResult<PluginMigrationRunResult>>;
    };
    settings: {
      get: (pluginId: string) => Promise<IpcResult<Record<string, unknown>>>;
      set: (
        pluginId: string,
        settings: Record<string, unknown>,
        actor?: { id: string; permissions: string[] }
      ) => Promise<IpcResult<Record<string, unknown>>>;
    };
  };
  extensions: {
    snapshot: () => Promise<IpcResult<ExtensionSnapshot>>;
  };
  sdl: {
    status: () => Promise<IpcResult<{ pluginId: string; active: boolean; scopes: string[]; segmentCount: number }>>;
    refreshFields: () => Promise<IpcResult<{ fields: PluginField[] }>>;
    validate: (segments: PluginSegmentDefinition[]) => Promise<IpcResult<{ valid: boolean; errors: string[]; warnings: string[] }>>;
    symbols: (segments: PluginSegmentDefinition[]) => Promise<IpcResult<{ symbols: unknown[]; baseSymbols: unknown[]; externalFields: unknown[] }>>;
    behavior: (payload: Record<string, unknown>) => Promise<IpcResult<Record<string, unknown>>>;
    preview: (payload: Record<string, unknown>) => Promise<IpcResult<Record<string, unknown>>>;
    templates: {
      list: (actor?: ActorContext | null) => Promise<IpcResult<SdlTemplate[]>>;
      create: (name: string, source: SdlDocument['source'], actor?: ActorContext | null) => Promise<IpcResult<SdlTemplate>>;
      delete: (id: number, actor?: ActorContext | null) => Promise<IpcResult<boolean>>;
    };
    document: {
      get: (actor?: ActorContext | null) => Promise<IpcResult<SdlDocument>>;
      set: (source: SdlDocument['source'], actor?: ActorContext | null) => Promise<IpcResult<{ document: SdlDocument; snapshot: SdlCompiledSnapshot; storageApplication: { status?: string } }>>;
    };
  };
  platformConfig: {
    get: () => Promise<IpcResult<PlatformConfigSnapshot>>;
    set: (settings: Partial<PlatformConfigSnapshot>) => Promise<IpcResult<PlatformConfigSnapshot>>;
    compileSdl: (actor?: ActorContext | null) => Promise<IpcResult<SdlCompiledSnapshot>>;
  };
  uiPreferences: {
    get: () => Promise<IpcResult<UiPreferences>>;
    set: (settings: Partial<UiPreferences>, actor?: ActorContext | null) => Promise<IpcResult<UiPreferences>>;
  };
  settings: {
    get: (code: string, key: string, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    getByCode: (code: string, actor?: ActorContext | null) => Promise<IpcResult<Record<string, unknown>>>;
    getReceipt: () => Promise<IpcResult<ReceiptPrintSettings>>;
    getBillingOutput: (actor?: ActorContext | null) => Promise<IpcResult<{ autoSavePdf: boolean; pdfFolder: string }>>;
    set: (code: string, key: string, value: unknown, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    setBulk: (code: string, settings: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<void>>;
    delete: (code: string, key: string, actor?: ActorContext | null) => Promise<IpcResult<boolean>>;
    listCodes: (actor?: ActorContext | null) => Promise<IpcResult<string[]>>;
  };
  priorityLists: {
    resolveForUser: (userId: number) => Promise<IpcResult<PriorityList>>;
    list: (actor?: ActorContext | null) => Promise<IpcResult<PriorityList[]>>;
    get: (id: number, actor?: ActorContext | null) => Promise<IpcResult<PriorityList | null>>;
    create: (payload: {
      name: string;
      entries?: string[];
      isDefault?: boolean;
    }, actor?: ActorContext | null) => Promise<IpcResult<PriorityList>>;
    update: (id: number, payload: {
      name?: string;
      entries?: string[];
      isDefault?: boolean;
    }, actor?: ActorContext | null) => Promise<IpcResult<PriorityList | null>>;
    delete: (id: number, actor?: ActorContext | null) => Promise<IpcResult<{ deleted: boolean }>>;
    setDefault: (id: number, actor?: ActorContext | null) => Promise<IpcResult<PriorityList | null>>;
    setAssignments: (
      listId: number,
      assignments: Array<{ targetType: 'role' | 'user'; targetId: number }>,
      actor?: ActorContext | null
    ) => Promise<IpcResult<{ assigned: number }>>;
    assignmentTargets: (actor?: ActorContext | null) => Promise<IpcResult<{
      users: Array<{ id: number; username: string; displayName: string }>;
      roles: Array<{ id: number; roleKey: string; name: string }>;
    }>>;
  };
  catalog: {
    listProducts: (options?: { includeInactive?: boolean }) => Promise<IpcResult<CatalogProduct[]>>;
    getProduct: (id: number) => Promise<IpcResult<CatalogProduct | null>>;
    createProduct: (payload: CatalogProductInput, actor?: ActorContext | null) => Promise<IpcResult<CatalogProduct>>;
    updateProduct: (
      id: number,
      updates: Partial<CatalogProductInput>,
      actor?: ActorContext | null
    ) => Promise<IpcResult<CatalogProduct | null>>;
    deleteProduct: (id: number, actor?: ActorContext | null) => Promise<IpcResult<{ deleted: boolean }>>;
    listProductCategories: () => Promise<IpcResult<string[]>>;
    listCustomers: () => Promise<IpcResult<unknown[]>>;
    searchCustomers: (term: string, actor?: ActorContext | null, options?: { outstandingOnly?: boolean; balanceOrder?: 'asc' | 'desc'; activityOrder?: 'asc' | 'desc'; sortBy?: 'balance' | 'activity' }) => Promise<IpcResult<Array<{ id: number; customer_code: string | null; name: string; phone: string | null; outstandingBalance: number; lastActivityAt?: string | null }>>>;
    getCustomerAccount: (customerId: number, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    createCustomer: (customer: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    updateCustomer: (customerId: number, customer: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    assignInvoiceCustomer: (payload: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    listCheques: (filters: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown[]>>;
    getCheque: (chequeId: number, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    updateChequeDetails: (payload: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    updateChequeStatus: (payload: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    linkCheque: (payload: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    listBusinessBankAccounts: (includeInactive?: boolean, actor?: ActorContext | null) => Promise<IpcResult<unknown[]>>;
    saveBusinessBankAccount: (account: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    listIssuedCheques: (filters: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown[]>>;
    getIssuedCheque: (chequeId: number, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    createIssuedCheque: (cheque: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
    updateIssuedChequeStatus: (payload: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<unknown>>;
  };
  customerAdvances: {
    balance: (customerAccountId: number, locCode: string, actor?: ActorContext | null) => Promise<IpcResult<number>>;
    summary: (customerAccountId: number, locCode: string, actor?: ActorContext | null) => Promise<IpcResult<CustomerAdvanceSummary>>;
    receive: (advance: { customerAccountId: number; sessionId: number; userId: number; reason: string; payments: PaymentLine[] }, actor?: ActorContext | null) => Promise<IpcResult<{ id: number; advanceNumber: string; amount: number; availableBalance: number }>>;
    refund: (refund: { customerAccountId: number; sessionId: number; userId: number; amount: number; method: string; fundAccountId?: number | null; providerRef?: string | null; reason: string }, actor?: ActorContext | null) => Promise<IpcResult<{ id: number; refundNumber: string; amount: number; availableBalance: number }>>;
  };
  funds: {
    list: (locCode: string, includeInactive?: boolean, actor?: ActorContext | null) => Promise<IpcResult<FundAccount[]>>;
    save: (fund: Partial<FundAccount> & { locCode: string }, actor?: ActorContext | null) => Promise<IpcResult<FundAccount>>;
    ledger: (query: { fundAccountId: number; locCode: string; fromDate?: string; toDate?: string; limit?: number }, actor?: ActorContext | null) => Promise<IpcResult<{ fund: FundAccount; movements: FundMovement[] }>>;
    transfer: (transfer: { fromFundAccountId: number; toFundAccountId: number; amount: number; reason: string; userId: number; origin: { locCode: string; macCode: string; txnDate: string } }, actor?: ActorContext | null) => Promise<IpcResult<{ transferNumber: string; amount: number; fromFund: string; toFund: string; fromBalance: number; toBalance: number }>>;
  };
  expenses: {
    categories: (includeInactive?: boolean, actor?: ActorContext | null) => Promise<IpcResult<ExpenseCategory[]>>;
    saveCategory: (category: Partial<ExpenseCategory>, actor?: ActorContext | null) => Promise<IpcResult<ExpenseCategory>>;
    list: (filters: { locCode: string; fromDate?: string; toDate?: string; categoryId?: number; fundAccountId?: number; term?: string; unallocatedOnly?: boolean; limit?: number }, actor?: ActorContext | null) => Promise<IpcResult<ExpenseRegister>>;
    create: (expense: { expenseCategoryId: number; fundAccountId: number; amount: number; reason: string; payee?: string; reference?: string; requestId?: string; userId: number; origin: { locCode: string; macCode: string; txnDate: string } }, actor?: ActorContext | null) => Promise<IpcResult<{ id: number; expenseNumber: string; amount: number; categoryName: string; categoryTreatment: ExpenseTreatment; fundName: string; fundBalance: number; stakeholderName: string | null; stakeholderEntryNumber: string | null; replayed?: boolean }>>;
    listRecurring: (locCode: string, includeInactive?: boolean, actor?: ActorContext | null) => Promise<IpcResult<RecurringExpense[]>>;
    saveRecurring: (template: Omit<Partial<RecurringExpense>, 'expenseCategoryId' | 'fundAccountId' | 'amount'> & { locCode: string; userId: number; expenseCategoryId: number | null; fundAccountId: number | null; amount: number | null }, actor?: ActorContext | null) => Promise<IpcResult<RecurringExpense>>;
    recordRecurring: (payload: { templateId: number; userId: number; origin: { locCode: string; macCode: string; txnDate: string } }, actor?: ActorContext | null) => Promise<IpcResult<{ expense: { id: number; expenseNumber: string }; schedule: { templateId: number; nextDueDate: string } }>>;
  };
  lotCosting: {
    lots: (filters: { locCode: string; term?: string; goodsReceiptId?: number; supplierId?: number; fromDate?: string; toDate?: string; limit?: number }, actor?: ActorContext | null) => Promise<IpcResult<CostedLot[]>>;
    profitability: (filters: { locCode: string; fromDate?: string; toDate?: string; supplierId?: number; goodsReceiptId?: number; ownershipModel?: string; term?: string; limit?: number }, actor?: ActorContext | null) => Promise<IpcResult<LotProfitability>>;
    lotDetail: (query: { inventoryLotId: number; locCode: string }, actor?: ActorContext | null) => Promise<IpcResult<{ lot: CostedLot; allocations: LotCostAllocation[] }>>;
    reconcile: (locCode: string, actor?: ActorContext | null) => Promise<IpcResult<{ checked: number; drifted: number; lots: Array<{ id: number; lotCode: string; storedLandedCost: number; expectedLandedCost: number }> }>>;
    allocate: (allocation: { expenseEntryId: number; inventoryLotId?: number | null; goodsReceiptId?: number | null; basis?: AllocationBasis; amount?: number | null; reason?: string; userId: number; origin: { locCode: string; macCode: string; txnDate: string } }, actor?: ActorContext | null) => Promise<IpcResult<{ expenseNumber: string; allocatedTotal: number; unallocatedTotal: number; basis: AllocationBasis; allocations: Array<{ lotId: number; lotCode: string; amount: number }>; lots: CostedLot[] }>>;
    reallocate: (reallocation: { expenseEntryId: number; fromInventoryLotId: number; toInventoryLotId: number; amount: number; reason: string; userId: number; origin: { locCode: string; macCode: string; txnDate: string } }, actor?: ActorContext | null) => Promise<IpcResult<{ reallocationNumber: string; amount: number; lots: CostedLot[] }>>;
  };
  stakeholders: {
    list: (locCode: string, includeInactive?: boolean, actor?: ActorContext | null) => Promise<IpcResult<Stakeholder[]>>;
    save: (stakeholder: Partial<Stakeholder> & { locCode: string }, actor?: ActorContext | null) => Promise<IpcResult<Stakeholder>>;
    statement: (query: { stakeholderId: number; locCode: string; fromDate?: string; toDate?: string; limit?: number }, actor?: ActorContext | null) => Promise<IpcResult<{ stakeholder: Stakeholder; entries: StakeholderEntry[] }>>;
    shares: (query: { stakeholderId?: number; inventoryLotId?: number }, actor?: ActorContext | null) => Promise<IpcResult<StakeholderShare[]>>;
    saveShare: (share: { stakeholderId: number; scope: 'business' | 'lot'; inventoryLotId?: number | null; sharePercent: number; effectiveFrom: string; notes?: string; userId: number }, actor?: ActorContext | null) => Promise<IpcResult<StakeholderShare[]>>;
    contribute: (entry: StakeholderMovementInput, actor?: ActorContext | null) => Promise<IpcResult<StakeholderMovementResult>>;
    draw: (entry: StakeholderMovementInput, actor?: ActorContext | null) => Promise<IpcResult<StakeholderMovementResult>>;
    settle: (entry: StakeholderMovementInput, actor?: ActorContext | null) => Promise<IpcResult<StakeholderMovementResult>>;
    profitShare: (entry: { stakeholderId: number; amount: number; inventoryLotId?: number | null; reason: string; userId: number; origin: { locCode: string; macCode: string; txnDate: string } }, actor?: ActorContext | null) => Promise<IpcResult<{ entryNumber: string; amount: number; stakeholderName: string; claim: number }>>;
    reconcile: (locCode: string, actor?: ActorContext | null) => Promise<IpcResult<{ ledgerTotal: number; journalTotal: number; difference: number; inBalance: boolean }>>;
  };
  accounting: {
    reconcile: (options: { locCode: string; macCode?: string; txnDate?: string; userId?: number }, actor?: ActorContext | null) => Promise<IpcResult<{ operational: Record<string, number>; lotCosts: { checked: number; changed: number; lots: unknown[] }; posted: number }>>;
    accounts: (actor?: ActorContext | null) => Promise<IpcResult<LedgerAccount[]>>;
    journal: (filters: { locCode: string; fromDate?: string; toDate?: string; limit?: number }, actor?: ActorContext | null) => Promise<IpcResult<JournalEntry[]>>;
    trialBalance: (filters: { locCode: string; fromDate?: string; toDate?: string }, actor?: ActorContext | null) => Promise<IpcResult<TrialBalance>>;
    profitAndLoss: (filters: { locCode: string; fromDate?: string; toDate?: string }, actor?: ActorContext | null) => Promise<IpcResult<{ income: TrialBalanceRow[]; expenses: TrialBalanceRow[]; incomeTotal: number; expenseTotal: number; netResult: number; coversCostsOnly: boolean }>>;
    balanceSheet: (filters: { locCode: string; fromDate?: string; toDate?: string }, actor?: ActorContext | null) => Promise<IpcResult<{ assets: TrialBalanceRow[]; liabilities: TrialBalanceRow[]; equity: TrialBalanceRow[]; assetTotal: number; liabilityTotal: number; equityTotal: number; retainedResult: number; difference: number; inBalance: boolean }>>;
    periods: (locCode: string, actor?: ActorContext | null) => Promise<IpcResult<AccountingPeriod[]>>;
    closePeriod: (period: { locCode: string; periodStart: string; periodEnd: string; macCode?: string; txnDate?: string; userId: number; notes?: string }, actor?: ActorContext | null) => Promise<IpcResult<{ id: number; periodStart: string; periodEnd: string; status: string }>>;
    reopenPeriod: (period: { periodId: number; userId: number; reason: string }, actor?: ActorContext | null) => Promise<IpcResult<{ id: number; status: string; reopenCount: number }>>;
  };
  pattiyals: {
    list: (filters: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<{ rows: Array<Record<string, any>>; total: number; page: number; pageSize: number }>>;
    get: (statementId: number, actor?: ActorContext | null) => Promise<IpcResult<PattiyalDetail | null>>;
    candidates: (filters: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<{ rows: PattiyalCandidate[]; total: number; page: number; pageSize: number; totals: Record<string, number> }>>;
    candidateGrns: (filters: Record<string, unknown>, actor?: ActorContext | null) => Promise<IpcResult<Array<Record<string, any>>>>;
    saveDraft: (statement: PattiyalDraftInput, actor?: ActorContext | null) => Promise<IpcResult<PattiyalDetail>>;
    review: (statementId: number, userId: number | null, actor?: ActorContext | null) => Promise<IpcResult<PattiyalDetail>>;
    reopen: (statementId: number, userId: number | null, reason: string, actor?: ActorContext | null) => Promise<IpcResult<PattiyalDetail>>;
    finalize: (statementId: number, userId: number | null, actor?: ActorContext | null) => Promise<IpcResult<PattiyalDetail>>;
    void: (statementId: number, userId: number | null, reason: string, actor?: ActorContext | null) => Promise<IpcResult<PattiyalDetail>>;
    setAttribution: (attribution: { invoiceItemId: number; supplierId: number; reason: string; userId?: number | null }, actor?: ActorContext | null) => Promise<IpcResult<Record<string, unknown>>>;
    exportXlsx: (document: PrintDocument, fileName: string, actor?: ActorContext | null) => Promise<IpcResult<{ filePath?: string; canceled?: boolean }>>;
    exportDocx: (document: PrintDocument, fileName: string, actor?: ActorContext | null) => Promise<IpcResult<{ filePath?: string; canceled?: boolean }>>;
  };
  businessDays: {
    state: (locationCode: string, actor?: ActorContext | null) => Promise<IpcResult<BusinessDayState>>;
    list: (locationCode: string, limit: number, actor?: ActorContext | null) => Promise<IpcResult<BusinessDay[]>>;
    startClosing: (dayId: number, actor?: ActorContext | null) => Promise<IpcResult<BusinessDayState>>;
    resumeTrading: (dayId: number, reason: string, actor?: ActorContext | null) => Promise<IpcResult<BusinessDayState>>;
    close: (dayId: number, reason: string, actor?: ActorContext | null) => Promise<IpcResult<{ day: BusinessDay; summary: BusinessDaySummary }>>;
    open: (locationCode: string, businessDate: string, actor?: ActorContext | null) => Promise<IpcResult<BusinessDayState>>;
    reopen: (dayId: number, reason: string, actor?: ActorContext | null) => Promise<IpcResult<BusinessDayState>>;
  };
  billing: {
    openBill: (session: BillContext, actor?: ActorContext) => Promise<IpcResult<OpenBillResult>>;
    searchInvoices: (filters: { term?: string; customerCode?: string; locCode?: string; macCode?: string; txnDate?: string; limit?: number }, actor?: ActorContext) => Promise<IpcResult<Array<Pick<InvoiceArchive, 'id' | 'invoice_number' | 'loc_code' | 'mac_code' | 'receipt_no' | 'txn_date' | 'status' | 'subtotal' | 'grandTotal' | 'paidTotal' | 'balance' | 'customer_code'>>>>;
    getInvoice: (invoiceId: number, actor?: ActorContext) => Promise<IpcResult<InvoiceArchive | null>>;
    collectInvoiceBalance: (payload: {
      invoiceId: number;
      sessionId: number;
      userId: number;
      payments: PaymentLine[];
    }, actor?: ActorContext) => Promise<IpcResult<{ invoiceId: number; invoiceNumber: string; collected: number; balance: number; status: string }>>;
    holdBill: (session: BillContext, actor?: ActorContext) => Promise<IpcResult<OpenBillResult>>;
    addItem: (bill: BillContext, item: {
      productId?: number | null;
      supplierCode?: string;
      itemCode: string;
      description: string;
      qty: number;
      kilos?: number | null;
      unitPrice: number;
      discount: number;
      tax?: number;
      metadata?: Record<string, unknown>;
      allocationPriorityLotId?: number | null;
      allocationPrioritySource?: 'automatic' | 'remembered' | 'manual' | null;
    }, actor?: ActorContext) => Promise<IpcResult<BillItem>>;
    updateCustomer: (bill: { locCode: string; macCode: string; txnDate: string; receiptNo: number; customerCode: string; customerAccountId?: number | null }, actor?: ActorContext) => Promise<IpcResult<{ customerCode: string; customerAccountId?: number | null }>>;
    updateItem: (itemId: number, updates: {
      qty: number;
      kilos?: number | null;
      unitPrice: number;
      discount: number;
      tax?: number;
      total: number;
      metadata?: Record<string, unknown>;
    }, actor?: ActorContext) => Promise<IpcResult<void>>;
    removeItem: (itemId: number, actor?: ActorContext) => Promise<IpcResult<void>>;
    getItems: (bill: {
      locCode: string;
      macCode: string;
      txnDate: string;
      receiptNo: number;
    }, actor?: ActorContext) => Promise<IpcResult<BillItem[]>>;
    updateBillHeader: (bill: BillContext, billHeader: Record<string, Record<string, unknown>>, actor?: ActorContext) => Promise<IpcResult<{ billHeader: Record<string, Record<string, unknown>> }>>;
    computeTotals: (bill: {
      locCode: string;
      macCode: string;
      txnDate: string;
      receiptNo: number;
    }, actor?: ActorContext) => Promise<IpcResult<BillTotals>>;
    finalize: (payload: {
      locCode: string;
      macCode: string;
      txnDate: string;
      receiptNo: number;
      sessionId: number;
      payments: PaymentLine[];
      userId?: number;
      customerCode: string;
      customerAccountId?: number | null;
    }, actor?: ActorContext) => Promise<IpcResult<FinalizeResult>>;
    paymentModes: (actor?: ActorContext) => Promise<IpcResult<PaymentMode[]>>;
    abandonBill: (bill: {
      locCode: string;
      macCode: string;
      txnDate: string;
      receiptNo: number;
    }, actor?: ActorContext) => Promise<IpcResult<void>>;
    recallBills: (locCode: string, macCode: string, txnDate: string, actor?: ActorContext) => Promise<IpcResult<HeldBill[]>>;
    loadBill: (bill: {
      locCode: string;
      macCode: string;
      txnDate: string;
      receiptNo: number;
    }, actor?: ActorContext) => Promise<IpcResult<{ locCode: string; macCode: string; txnDate: string; receiptNo: number; customerCode?: string; customerAccountId?: number | null; items: BillItem[]; billHeader?: Record<string, Record<string, unknown>> }>>;
    lotCandidates: (options: { productId: number; locCode: string; txnDate: string; limit?: number }, actor?: ActorContext) => Promise<IpcResult<InventoryLotCandidate[]>>;
    rememberLot: (options: { productId: number; locCode: string; txnDate: string; lotId: number }, actor?: ActorContext) => Promise<IpcResult<{ lotId: number }>>;
    clearRememberedLot: (options: { productId: number; locCode: string }, actor?: ActorContext) => Promise<IpcResult<{ cleared: boolean }>>;
    setItemLotPriority: (options: { itemId: number; lotId: number | null; source: 'automatic' | 'remembered' | 'manual' | null }, actor?: ActorContext) => Promise<IpcResult<{ itemId: number; lotId: number | null; source: string | null }>>;
    searchProducts: (term: string, actor?: ActorContext) => Promise<IpcResult<unknown[]>>;
  };
  refunds: {
    searchSourceInvoices: (options?: { term?: string; customerCode?: string; locCode?: string; macCode?: string; txnDate?: string; limit?: number }, actor?: ActorContext) => Promise<IpcResult<Array<{
      id: number;
      invoice_number: string;
      loc_code: string;
      mac_code: string;
      receipt_no: number;
      txn_date: string;
      customer_code?: string;
      grandTotal: number;
      paidTotal: number;
      refundedTotal: number;
      refundableTotal: number;
    }>>>;
    getSource: (invoiceId: number, actor?: ActorContext) => Promise<IpcResult<RefundSourceInvoice>>;
    createDraft: (draft: {
      sourceInvoiceId: number;
      sessionId: number;
      locCode: string;
      macCode: string;
      txnDate: string;
      userId?: number;
      reason?: string;
    }, actor?: ActorContext) => Promise<IpcResult<{ draftId: number; refundNo: number }>>;
    getDraft: (draftId: number, actor?: ActorContext) => Promise<IpcResult<RefundDraft | null>>;
    listActive: (context: { locCode: string; macCode: string; txnDate: string }, actor?: ActorContext) => Promise<IpcResult<RefundActiveDraft[]>>;
    saveItem: (item: {
      draftId: number;
      sourceInvoiceId: number;
      sourceItemId: number;
      quantity?: number;
      kilos?: number;
      stockDisposition?: 'sellable' | 'damaged' | 'waste';
      bagChargeMode?: 'proportional' | 'exclude' | 'custom';
      bagChargeTotal?: number;
      wageChargeMode?: 'proportional' | 'exclude' | 'custom';
      wageChargeTotal?: number;
    }, actor?: ActorContext) => Promise<IpcResult<RefundDraft>>;
    removeItem: (draftId: number, sourceInvoiceItemId: number, actor?: ActorContext) => Promise<IpcResult<RefundDraft>>;
    hold: (draftId: number, userId: number, actor?: ActorContext) => Promise<IpcResult<RefundDraft>>;
    resume: (draftId: number, userId: number, actor?: ActorContext) => Promise<IpcResult<RefundDraft>>;
    abandon: (draftId: number, userId: number, actor?: ActorContext) => Promise<IpcResult<RefundDraft>>;
    finalize: (refund: {
      draftId: number;
      payments: PaymentLine[];
      userId: number;
      sessionId: number;
      reason?: string;
    }, actor?: ActorContext) => Promise<IpcResult<RefundFinalizeResult>>;
  };
  cash: {
    activeShift: (sessionId: number, actor?: ActorContext) => Promise<IpcResult<CashShift | null>>;
    recoverableShift: (workstationId: number, userId: number, actor?: ActorContext) => Promise<IpcResult<CashShift | null>>;
    getShift: (shiftId: number, actor?: ActorContext) => Promise<IpcResult<CashShift | null>>;
    reportHistory: (shiftId: number, actor?: ActorContext) => Promise<IpcResult<CashShiftReportPrint[]>>;
    archiveReportPrint: (
      payload: {
        shiftId: number;
        reportType: 'X' | 'Z';
        reportNo?: number | null;
        snapshot?: Record<string, unknown>;
        userId: number;
      },
      actor?: ActorContext
    ) => Promise<IpcResult<CashShiftReportPrint>>;
    openShift: (shift: {
      workstationSessionId: number;
      workstationId: number;
      userId: number;
      businessDate: string;
      openingLines: CashCountLine[];
    }, actor?: ActorContext) => Promise<IpcResult<CashShift>>;
    addMovement: (movement: {
      shiftId: number;
      type: 'cash_in' | 'cash_out' | 'safe_drop' | 'bank_drop' | 'correction_in' | 'correction_out';
      amount: number;
      reason: string;
      userId: number;
    }, actor?: ActorContext) => Promise<IpcResult<CashShift>>;
    correctMovement: (movement: { movementId: number; direction: 'in' | 'out'; amount: number; reason: string; userId?: number }, actor?: ActorContext) => Promise<IpcResult<CashShift>>;
    removeMovement: (movement: { movementId: number; reason: string; userId?: number }, actor?: ActorContext) => Promise<IpcResult<CashShift>>;
    movementHistory: (filters: { locCode: string; fromDate?: string; toDate?: string; direction?: 'in' | 'out' | ''; movementType?: string; term?: string; includeVoided?: boolean; limit?: number }, actor?: ActorContext) => Promise<IpcResult<CashMovementHistoryRow[]>>;
    blindClose: (count: { shiftId: number; userId: number; closingLines: CashCountLine[] }, actor?: ActorContext) => Promise<IpcResult<CashShift>>;
    closeShift: (close: { shiftId: number; userId: number; varianceReason?: string }, actor?: ActorContext) => Promise<IpcResult<CashShift>>;
  };
  reports: {
    salesSummary: () => Promise<IpcResult<unknown>>;
    salesDetail: (filters: Record<string, unknown>, actor?: ActorContext) => Promise<IpcResult<unknown>>;
    salesItems: (filters: Record<string, unknown>, actor?: ActorContext) => Promise<IpcResult<unknown>>;
    supplierSummary: (filters: Record<string, unknown>, actor?: ActorContext) => Promise<IpcResult<unknown>>;
    inventorySummary: (filters: Record<string, unknown>, actor?: ActorContext) => Promise<IpcResult<unknown>>;
    exportDdecXlsx: (filters: Record<string, unknown>, actor?: ActorContext) => Promise<IpcResult<{ canceled?: boolean; filePath?: string }>>;
    exportSalesXlsx: (filters: Record<string, unknown>, actor?: ActorContext) => Promise<IpcResult<{ canceled?: boolean; filePath?: string }>>;
  };
  fieldInbox: {
    getConfiguration: (actor?: ActorContext | null) => Promise<IpcResult<FieldInboxConfiguration>>;
    saveConfiguration: (
      configuration: { hostId: string; apiKey?: string; clearApiKey?: boolean },
      actor?: ActorContext | null
    ) => Promise<IpcResult<FieldInboxConfiguration>>;
    testConnection: (
      date: string,
      actor?: ActorContext | null
    ) => Promise<IpcResult<{ connected: boolean; hostId: string; recordCount: number; range: { since: string; until: string } }>>;
    listRecords: (date: string, actor?: ActorContext | null) => Promise<IpcResult<FieldInboxRecordList>>;
    setResolved: (
      recordId: string,
      clientRecordId: string | null,
      resolved: boolean,
      actor?: ActorContext | null
    ) => Promise<IpcResult<{ resolved: boolean; resolvedAt: string | null; resolvedBy: number | null }>>;
    getMedia: (
      mediaId: string,
      actor?: ActorContext | null
    ) => Promise<IpcResult<{ mediaId: string; contentType: string; sizeBytes: number; dataBase64: string }>>;
  };
  cloudSync: {
    getConfiguration: (actor?: ActorContext | null) => Promise<IpcResult<CloudSyncConfiguration>>;
    saveConfiguration: (
      configuration: { enabled: boolean; intervalMinutes: number; batchSize: number; maxBatchesPerRun: number; nickname?: string },
      actor?: ActorContext | null
    ) => Promise<IpcResult<CloudSyncConfiguration>>;
    runNow: (actor?: ActorContext | null) => Promise<IpcResult<CloudSyncConfiguration & { uploaded?: number; catalogPublished?: boolean }>>;
    listMobileBills: (since: string, until: string, actor?: ActorContext | null) => Promise<IpcResult<{ nodeId: string; cursor: string; bills: MobileInboxBill[] }>>;
    setMobileBillStatus: (billId: string, status: 'viewed' | 'printed', actor?: ActorContext | null) => Promise<IpcResult<{ status: string }>>;
  };
  users: {
    list: (actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManageUser[]>>;
    get: (id: number, actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManageUserDetail>>;
    create: (payload: {
      username: string;
      password: string;
      displayName: string;
      email?: string | null;
      phone?: string | null;
      status?: string;
      roleIds?: number[];
    }, actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManageUserDetail>>;
    update: (id: number, payload: {
      displayName?: string;
      email?: string | null;
      phone?: string | null;
      status?: string;
    }, actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManageUserDetail>>;
    updatePassword: (id: number, newPassword: string, actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<{ updated: boolean }>>;
    delete: (id: number, actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<{ deleted: boolean }>>;
    setRoles: (userId: number, roleIds: number[], actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManageUserDetail>>;
  };
  roles: {
    list: (actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManageRole[]>>;
    get: (id: number, actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManageRoleDetail>>;
    create: (payload: { roleKey: string; name: string }, actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManageRoleDetail>>;
    update: (id: number, payload: { name?: string }, actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManageRoleDetail>>;
    delete: (id: number, actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<{ deleted: boolean }>>;
    setPermissions: (roleId: number, permissionIds: number[], actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManageRoleDetail>>;
  };
  permissions: {
    list: (actor?: { id: string; permissions: string[] } | null) => Promise<IpcResult<ManagePermission[]>>;
  };
  printing: {
    list: (actor?: ActorContext | null) => Promise<IpcResult<PrinterDevice[]>>;
    defaultGet: (actor?: ActorContext | null) => Promise<IpcResult<string | null>>;
    defaultSet: (printerId: string, actor?: ActorContext | null) => Promise<IpcResult<{ updated: boolean }>>;
    printDocument: (doc: PrintDocument, printerId?: string | null, actor?: ActorContext | null) => Promise<IpcResult<PrintResult>>;
    savePdf: (doc: PrintDocument, options: { prompt?: boolean; filePath?: string; directory?: string; fileName?: string }, actor?: ActorContext | null) => Promise<IpcResult<{ filePath?: string; canceled?: boolean }>>;
    printTestPage: (printerId?: string | null, actor?: ActorContext | null) => Promise<IpcResult<PrintResult>>;
  };
}
