import { readSgNativeChartReference, selectSgProvisionalChart } from './sfrsChart.js';
import { NATIVE_GST_REGISTRATION_POLICY } from './gstRegistration.js';

// An internal, provisional birth contract. No production caller selects it;
// defaultChart, public admission and coding remain unchanged.
export const SG_PROVISIONING_POLICY = Object.freeze({
  provisionalChart: selectSgProvisionalChart,
  nativeRegistration: NATIVE_GST_REGISTRATION_POLICY,
  birthContracts: Object.freeze({
    'sg_pte_native.v1': () => ({
      contract_id: 'sg_pte_native.v1', menu_contract_version: 1,
      coding_aliases: { Rent: '7000', Travel: '7300', Marketing: '7600' },
      selection_digest: 'b8d009df683c2f6436a07ca92ed21c1d5c9a4ef5e3605a7419a55f7aa3f3f16e',
      reference_digest: 'a9a5fcd01ce8d62c2fdcb1f250e59a4fab82acc232b7537b27733ef9c63d80b5',
      reference: readSgNativeChartReference(),
      selection: selectSgProvisionalChart({ jurisdiction: 'sg', legalForm: 'sg-pte' })
    })
  })
});
