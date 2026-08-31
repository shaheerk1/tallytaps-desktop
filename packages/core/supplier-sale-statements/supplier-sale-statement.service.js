'use strict';

function createSupplierSaleStatementService({ repository }) {
  if (!repository) throw new Error('Supplier sale statement service requires a repository.');

  return {
    list: (filters) => repository.listStatements(filters || {}),
    get: (statementId) => repository.getStatement(statementId),
    candidates: (filters) => repository.listCandidates(filters || {}),
    candidateGrns: (filters) => repository.listCandidateGrns(filters || {}),
    saveDraft: (statement) => repository.saveDraft(statement || {}),
    review: (statementId, userId) => repository.reviewStatement(statementId, userId),
    reopen: (statementId, userId, reason) => repository.reopenStatement(statementId, userId, reason),
    finalize: (statementId, userId) => repository.finalizeStatement(statementId, userId),
    void: (statementId, userId, reason) => repository.voidStatement(statementId, userId, reason),
    setAttribution: (payload) => repository.setInvoiceItemAttribution(payload || {})
  };
}

module.exports = { createSupplierSaleStatementService };
