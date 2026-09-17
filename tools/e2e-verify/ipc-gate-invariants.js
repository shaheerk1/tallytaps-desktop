/**
 * The IPC gate, end to end.
 *
 * Runs on the real app booted against a throwaway copy of the database (see
 * lib/ipc-harness) and calls the handlers exactly as the preload does, token
 * and all. The real database is only ever read.
 */
const { runVerifier, assert } = require('./lib/ipc-harness');

runVerifier('IPC gate invariants', async (app) => {
  const { services, handlers, call, ok } = app;
  const passed = [];
  const tableCount = app.tableCount;
  const login = (username, password, workstationId) => app.login(username, password, workstationId);

  const status = await services.migrationRunner.status();
  assert(status.pending.length === 0, `The copy must have no pending migrations: ${status.pending.join(', ')}`);
  passed.push(`the real container and IPC registry boot on a copy of the database (${tableCount} tables, all ${status.total} migrations)`);

  // ── No token, no access ───────────────────────────────
  const anonymous = await call('funds.list', { locCode: 'ANY' });
  assert(!anonymous.success && /session has ended/i.test(anonymous.error), 'A protected call without a token must be refused.');
  const catalogOpen = await call('catalog.products.list', {});
  assert(!catalogOpen.success, 'The catalog must no longer be readable without signing in.');
  passed.push('a protected call without a session token is refused, including the catalog');

  // ── Set up two businesses from the admin screens ──────
  const first = await login('verify_admin', 'verify-admin-pass', null);
  assert(first.success, `Admin sign-in failed: ${first.error}`);
  await ok('locations.create', { location: { locCode: 'KST01', businessCode: 'KHANSTORE', name: 'Khan Store' } });
  await ok('locations.create', { location: { locCode: 'KRT01', businessCode: 'KHANRETAIL', name: 'Khan Retail' } });
  const store = await ok('workstations.create', { locationCode: 'KST01', machineCode: 'T1', name: 'Store counter' });
  const retail = await ok('workstations.create', { locationCode: 'KRT01', machineCode: 'T1', name: 'Retail counter' });
  const listed = await ok('workstations.list', {});
  assert(listed.every((row) => row.business_code), 'The login picker must receive each workstation’s business.');
  await app.logout();
  passed.push('locations and workstations are set up through the real admin channels');

  // ── Sign in to the store; the gate owns identity ──────
  const atStore = await login('verify_admin', 'verify-admin-pass', store.id);
  assert(atStore.success && atStore.data.workstationSession.locationCode === 'KST01', 'Signing in to the store counter must land at KST01.');
  for (const loc of ['KST01', 'KRT01']) {
    await services.database.withConnection((c) => c.execute(
      "INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, '2099-07-01', 'open', ?)",
      [loc, atStore.data.user.id]
    ));
  }
  const emptyStore = await ok('catalog.products.list', {});
  assert(emptyStore.length === 0, `A new location must start with an empty catalog, found ${emptyStore.length} items.`);
  passed.push('a new location starts with an empty catalog; the existing 190 items stay with their own location');

  const onion = await ok('catalog.products.create', { sku: 'ONION', name: 'Big onion', unitPrice: 280, locCode: 'KRT01' });
  const [[row]] = await services.database.withConnection((c) => c.execute('SELECT loc_code FROM products WHERE id = ?', [onion.id]));
  assert(row.loc_code === 'KST01', `An item created at the store must join the store's catalog, not ${row.loc_code}.`);
  passed.push('an item created while signed in to the store joins the store’s catalog, whatever location the screen named');

  // Forged permissions: a user with no roles sends a list claiming everything.
  await ok('users.create', { username: 'nobody', password: 'nobody-pass', displayName: 'No roles', email: 'nobody@verify.local' });
  await app.logout();
  const nobody = await login('nobody', 'nobody-pass', retail.id);
  assert(nobody.success, `The no-role user could not sign in: ${nobody.error}`);
  const forged = await call('funds.list', { actor: { id: '1', permissions: ['funds.view', 'settings.manage', 'users.manage'] } });
  assert(!forged.success && /Permission denied/.test(forged.error), 'Permissions the screen claims must be ignored.');
  passed.push('a user with no roles cannot use a permission by claiming it from the screen');
  await app.logout();

  // ── Moving business without signing out ──────────────
  // Sign in to the store, then -- without signing out, as a second window or a
  // forgotten session would -- sign in to the retail counter.
  const againAtStore = await login('verify_admin', 'verify-admin-pass', store.id);
  assert(againAtStore.success, `Signing in to the store again failed: ${againAtStore.error}`);
  const storeToken = app.token;
  const atRetail = await login('verify_admin', 'verify-admin-pass', retail.id);
  assert(atRetail.success && atRetail.data.workstationSession.locationCode === 'KRT01', 'Choosing the retail counter must land at KRT01.');
  assert((atRetail.data.workstationSession.closedElsewhere || []).includes('Store counter'),
    'Moving to retail must close the store session and say so.');
  passed.push('choosing the retail counter lands there and closes the store session, even without signing out');

  const retailCatalog = await ok('catalog.products.list', {});
  assert(retailCatalog.length === 0, 'The retail business must not see the store’s items.');
  const sameSku = await ok('catalog.products.create', { sku: 'ONION', name: 'Big onion', unitPrice: 320 });
  assert(Number(sameSku.unit_price) === 320, 'Retail keeps its own price for the same SKU.');
  passed.push('the retail business sees none of the store’s items, and the same SKU carries its own price');

  // ── The bill prints the location's own details ───────
  // The settings screen saves the address for the signed-in location; the bill
  // must read that same row, not the shared one.
  const sharedReceipt = await services.settingsService.getSettingsByCode('general');
  await ok('settings.setBulk', { code: 'general', settings: { store_name: 'Khan Retail', store_address_1: '7 Retail Road', store_phone: '0110000000' } });
  const retailReceipt = await ok('settings.receipt.get', {});
  assert(retailReceipt.storeName === 'Khan Retail' && retailReceipt.addressLines[0] === '7 Retail Road' && retailReceipt.phone === '0110000000',
    `The retail bill must print what retail saved, got ${JSON.stringify([retailReceipt.storeName, retailReceipt.addressLines, retailReceipt.phone])}.`);
  const retailForm = await ok('settings.getByCode', { code: 'general' });
  assert(retailForm.store_address_1 === retailReceipt.addressLines[0], 'The settings screen and the bill must show the same address.');
  const [[workstationCopies]] = await services.database.withConnection((c) => c.execute(
    "SELECT COUNT(*) AS n FROM system_settings WHERE code = 'workstation' AND `key` IN ('store_address_1','store_address_2','store_phone','default_printer')"
  ));
  assert(Number(workstationCopies.n) === 0, 'No second copy of the address or phone may remain in the workstation group.');
  const anonymousReceipt = await handlers.get('settings.receipt.get')(null, {});
  assert(!anonymousReceipt.success, 'The receipt details must not be readable without signing in.');
  let anonymousRead = null;
  try { await services.requestContext.runAnonymous(() => services.settingsService.getSettingsByCode('general')); } catch (error) { anonymousRead = error.message; }
  assert(anonymousRead && /belong to a location/.test(anonymousRead), 'A channel with no sign-in must be refused location settings, not handed the shared ones.');
  const ui = await handlers.get('uiPreferences.get')(null, {});
  assert(ui.success, `Shared screen preferences must stay readable before sign-in: ${ui.error}`);
  passed.push('the bill prints the address the signed-in location saved, the settings screen shows that same value, and no second copy remains');

  // The store sign-in is still a valid login, but its workstation session is
  // closed: it may no longer record anything anywhere.
  const stale = await handlers.get('expenses.create')(null, {
    __token: storeToken, expense: { amount: 1, reason: 'Stale', expenseCategoryId: 1, fundAccountId: 1, origin: { locCode: 'KST01', macCode: 'T1', txnDate: '2099-07-01' } }
  });
  assert(!stale.success && /workstation session/i.test(stale.error),
    `A sign-in whose workstation session was closed must be refused for that reason, got: ${stale.error}`);
  passed.push('a still-valid sign-in whose workstation session was closed can record nothing, even naming a location');

  // Back at the store, retail's address must not follow.
  const backAtStore = await login('verify_admin', 'verify-admin-pass', store.id);
  assert(backAtStore.success, `Signing back in to the store failed: ${backAtStore.error}`);
  const storeReceipt = await ok('settings.receipt.get', {});
  assert(storeReceipt.addressLines[0] !== '7 Retail Road' && (storeReceipt.addressLines[0] || '') === String(sharedReceipt.store_address_1 || '').trim(),
    `The store bill must keep its own (shared) address, got ${storeReceipt.addressLines[0]}.`);
  passed.push('another location’s saved address never appears on this location’s bill');

  return passed;
});
