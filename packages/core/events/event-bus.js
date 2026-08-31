function createEventBus() {
  const listeners = new Map();
  const beforeListeners = new Map();
  const afterListeners = new Map();

  return {
    subscribe(eventName, listener) {
      const eventListeners = listeners.get(eventName) || [];
      eventListeners.push(listener);
      listeners.set(eventName, eventListeners);

      return () => {
        const currentListeners = listeners.get(eventName) || [];
        listeners.set(
          eventName,
          currentListeners.filter((currentListener) => currentListener !== listener)
        );
      };
    },
    async publish(eventName, payload) {
      const eventListeners = listeners.get(eventName) || [];

      for (const listener of eventListeners) {
        await listener(payload);
      }
    },
    subscribeBefore(eventName, listener) {
      const eventListeners = beforeListeners.get(eventName) || [];
      eventListeners.push(listener);
      beforeListeners.set(eventName, eventListeners);

      return () => {
        const currentListeners = beforeListeners.get(eventName) || [];
        beforeListeners.set(
          eventName,
          currentListeners.filter((currentListener) => currentListener !== listener)
        );
      };
    },
    subscribeAfter(eventName, listener) {
      const eventListeners = afterListeners.get(eventName) || [];
      eventListeners.push(listener);
      afterListeners.set(eventName, eventListeners);

      return () => {
        const currentListeners = afterListeners.get(eventName) || [];
        afterListeners.set(
          eventName,
          currentListeners.filter((currentListener) => currentListener !== listener)
        );
      };
    },
    async publishBefore(eventName, payload) {
      const eventListeners = beforeListeners.get(eventName) || [];
      let mutablePayload = payload;
      for (const listener of eventListeners) {
        const result = await listener(mutablePayload);
        if (result !== undefined) {
          mutablePayload = result;
        }
      }
      return mutablePayload;
    },
    async publishAfter(eventName, payload) {
      const eventListeners = afterListeners.get(eventName) || [];
      for (const listener of eventListeners) {
        await listener(payload);
      }
    },
    async publishAsync(eventName, payload) {
      const eventListeners = listeners.get(eventName) || [];
      await Promise.all(eventListeners.map(async (listener) => listener(payload)));
    }
  };
}

module.exports = {
  createEventBus
};
