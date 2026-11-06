import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  firmClientProfiles as demoFirmClientProfiles,
  firmMockHistory as demoFirmMockHistory,
  firmMockQueue as demoFirmMockQueue
} from '../../src/lib/mockData.js';

const PRIVATE_FIRM_PROFILE_PATH = 'src/private/firmClientProfile.local.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

const loadPrivateFirmData = async () => {
  if (!existsSync(PRIVATE_FIRM_PROFILE_PATH)) return {};
  try {
    const module = await import(pathToFileURL(`${process.cwd()}/${PRIVATE_FIRM_PROFILE_PATH}`).href);
    return module.default || module;
  } catch {
    return {};
  }
};

export const getFirmSeedSnapshot = async () => {
  const privateFirmData = await loadPrivateFirmData();
  const privateClients =
    privateFirmData.firmClientProfiles ||
    (privateFirmData.firmClientProfile ? [privateFirmData.firmClientProfile] : []);
  const privateQueue = privateFirmData.firmMockQueue || [];
  const privateHistory = privateFirmData.firmMockHistory || [];

  return {
    source: 'seed',
    firm: {
      id: 'donna-demo-firm',
      name: 'Donna Firms Demo',
      slug: 'donna-demo',
      jurisdiction: 'SG',
      defaultCurrency: 'SGD',
      metadata: { seed: true }
    },
    members: [
      {
        id: 'member-kari',
        firm_id: 'donna-demo-firm',
        email: 'kari@books.example',
        name: 'Kari',
        role: 'admin',
        status: 'active',
        access_level: 'owner',
        metadata: {}
      }
    ],
    collaborators: [
      {
        id: 'collab-bookkeeping-pod',
        firm_id: 'donna-demo-firm',
        email: 'bookkeeping-pod@example-local.example',
        name: 'Bookkeeping Pod',
        vendor_company: 'External Ops Partner',
        country: 'PH',
        role: 'bookkeeper',
        status: 'active',
        access_level: 'client_scoped',
        metadata: { seed: true }
      }
    ],
    assignments: [],
    clients: clone([...privateClients, ...demoFirmClientProfiles]),
    documents: [],
    transactions: [],
    accountingRules: [],
    queue: clone([...privateQueue, ...demoFirmMockQueue]),
    history: clone([...privateHistory, ...demoFirmMockHistory])
  };
};
