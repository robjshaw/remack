/**
 * OAuth installations on the storage contract.
 *
 * Key scheme in namespace 'installations':
 *   org-wide (Enterprise Grid) installs → E:{enterpriseId}
 *   single-workspace installs           → T:{teamId}
 *
 * Workspace lookups fall back to the org-wide record, so a grid-installed
 * app resolves tokens for every workspace under the enterprise.
 */

const NS = 'installations';

export function installationsFrom(storage) {
  return {
    async set(installation) {
      const key = installation.isEnterpriseInstall && installation.enterprise?.id
        ? `E:${installation.enterprise.id}`
        : `T:${installation.team?.id}`;
      await storage.put(NS, key, installation);
    },

    async get({ teamId, enterpriseId, isEnterpriseInstall } = {}) {
      if (isEnterpriseInstall && enterpriseId) {
        return storage.get(NS, `E:${enterpriseId}`);
      }
      if (teamId) {
        const workspace = await storage.get(NS, `T:${teamId}`);
        if (workspace) return workspace;
        if (enterpriseId) return storage.get(NS, `E:${enterpriseId}`);
        return null;
      }
      if (enterpriseId) return storage.get(NS, `E:${enterpriseId}`);
      throw new Error('Either teamId or enterpriseId is required');
    },

    async delete({ teamId, enterpriseId, isEnterpriseInstall } = {}) {
      if (isEnterpriseInstall && enterpriseId) {
        await storage.delete(NS, `E:${enterpriseId}`);
        return;
      }
      if (teamId) await storage.delete(NS, `T:${teamId}`);
    },

    async list() {
      const entries = await storage.list(NS);
      return entries.map(({ value }) => value);
    },
  };
}
