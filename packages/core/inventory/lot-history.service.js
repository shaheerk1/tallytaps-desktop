/**
 * Lot history.
 *
 * Reading back what a lot did, long after it stopped holding stock. Every read
 * is limited to the signed-in workstation's own location: a lot id is just a
 * number, and a number typed into a screen must not reach another shop's
 * goods, so the location comes from the request and never from the caller.
 */
const requestContext = require('../security/request-context');

function createLotHistoryService({ lotHistoryRepository }) {
  if (!lotHistoryRepository) throw new Error('Lot history service requires a repository.');

  const text = (value) => String(value || '').trim();

  function scope(input = {}) {
    const locCode = requestContext.scopedLocation(input) || text(input.locCode);
    if (!locCode) throw new Error('A location is required to read lot history.');
    return locCode;
  }

  function lotId(input = {}) {
    const id = Number(input.inventoryLotId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Select a lot.');
    return id;
  }

  const STATUSES = ['all', 'live', 'retired'];

  async function listLots(filters = {}) {
    const status = STATUSES.includes(filters.status) ? filters.status : 'all';
    return lotHistoryRepository.listLotHistory({ ...filters, status, locCode: scope(filters) });
  }

  async function getSummary(query = {}) {
    return lotHistoryRepository.getLotSummary({ inventoryLotId: lotId(query), locCode: scope(query) });
  }

  async function listSaleLines(query = {}) {
    return lotHistoryRepository.listLotSaleLines({ inventoryLotId: lotId(query), locCode: scope(query) });
  }

  async function listBills(query = {}) {
    return lotHistoryRepository.listLotBills({ inventoryLotId: lotId(query), locCode: scope(query) });
  }

  return { listLots, getSummary, listSaleLines, listBills };
}

module.exports = { createLotHistoryService };
