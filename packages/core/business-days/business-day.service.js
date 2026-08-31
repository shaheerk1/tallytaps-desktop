function createBusinessDayService({ businessDayRepository }) {
  if (!businessDayRepository) throw new Error('Business day service requires a repository.');

  const requiredId = (value, label) => {
    const id = Number(value || 0);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`${label} is required.`);
    return id;
  };

  async function getState({ locationCode }) {
    const location = String(locationCode || '').trim();
    if (!location) throw new Error('A location is required to load business-day control.');
    return businessDayRepository.getOperationalState({ locationCode: location });
  }

  async function list({ locationCode, limit }) {
    const location = String(locationCode || '').trim();
    if (!location) return [];
    return businessDayRepository.list({ locationCode: location, limit });
  }

  async function startClosing({ dayId, userId }) {
    return businessDayRepository.startClosing({
      dayId: requiredId(dayId, 'Business day'),
      userId: requiredId(userId, 'User')
    });
  }

  async function resumeTrading({ dayId, userId, reason }) {
    return businessDayRepository.resumeTrading({
      dayId: requiredId(dayId, 'Business day'),
      userId: requiredId(userId, 'User'),
      reason: String(reason || '').trim()
    });
  }

  async function closeDay({ dayId, userId, reason }) {
    return businessDayRepository.closeDay({
      dayId: requiredId(dayId, 'Business day'),
      userId: requiredId(userId, 'User'),
      reason: String(reason || '').trim()
    });
  }

  async function openDay({ locationCode, businessDate, userId }) {
    return businessDayRepository.openDay({
      locationCode: String(locationCode || '').trim(),
      businessDate,
      userId: requiredId(userId, 'User')
    });
  }

  async function reopenDay({ dayId, userId, reason }) {
    return businessDayRepository.reopenDay({
      dayId: requiredId(dayId, 'Business day'),
      userId: requiredId(userId, 'User'),
      reason: String(reason || '').trim()
    });
  }

  return {
    getState,
    list,
    startClosing,
    resumeTrading,
    closeDay,
    openDay,
    reopenDay,
    assertOpen: (payload) => businessDayRepository.assertOpen(payload)
  };
}

module.exports = { createBusinessDayService };
