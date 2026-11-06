import { gbDefaultChartForEntityType, GB_DEFAULT_CHART } from './defaultChart.js';
import { resolveGbVatRegistrationOnDate } from './vatRegistration.js';
export const GB_PROVISIONING_POLICY = Object.freeze({
  defaultChart: gbDefaultChartForEntityType,
  certificateCharts: Object.freeze({ 'gb_default_chart.v1': GB_DEFAULT_CHART }),
  requiredRoles({ profile, onDate }) {
    const registered = resolveGbVatRegistrationOnDate({ registration: profile?.vat_registration ?? null, onDate }).registered;
    return { roles: registered === true ? ['liability.sales_tax_payable'] : [], evidence: { gb_vat_registered: registered } };
  }
});
