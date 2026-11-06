// AR-3B's shipping interface-localization boundary.
//
// Keep this list explicit. Reachability is checked from src/main.jsx in CI, while
// this manifest decides which mounted modules are release-gated for catalog,
// formatter, bidi, and logical-layout regressions. Marketing/legal and developer
// laboratories are deliberately outside the declaration in the binding design.
// Tracks the installed catalog version (mountedSurfaceContract.test.js pins them
// equal). Hosted pilot inspection adds sixteen messages and declares both the
// owner journal view and the shared extracted ALV panel.
export const SUPPORTED_SURFACE_MANIFEST_VERSION = '2026-09-28.sg-native-intake.1';

export const SUPPORTED_SURFACE_GROUPS = Object.freeze({
  entry: Object.freeze([
    'src/main.jsx',
    'src/App.jsx'
  ]),
  access: Object.freeze([
    'src/components/ExistingOwnerRevalidation.jsx',
    'src/components/FirmAuthGate.jsx',
    'src/components/FirstRunOnboarding.jsx',
    'src/components/FirmNewEntity.jsx',
    'src/components/ClientPortalGate.jsx',
    'src/components/WebBooksUnavailable.jsx'
  ]),
  shell: Object.freeze([
    'src/components/DesktopTitlebar.jsx',
    'src/components/FirmSidebar.jsx',
    'src/components/firm-dock.jsx',
    'src/components/FirmOpsConsole.jsx'
  ]),
  settingsAndTeam: Object.freeze([
    'src/components/settings/SettingsSidebar.jsx',
    'src/components/settings/SettingsPanel.jsx',
    'src/components/settings/FinnishPilotSetupCard.jsx',
    'src/components/settings/AccountingImportCard.jsx',
    'src/components/settings/RuntimeRepairsCard.jsx',
    'src/components/TeamPanel.jsx',
    'src/components/FeedbackModal.jsx'
  ]),
  workspaces: Object.freeze([
    'src/components/FirmClientWorkspace.jsx',
    'src/components/FinnishCompanyDetails.jsx',
    'src/components/outbound-owner-actions.jsx',
    'src/components/donna-actions-panel.jsx',
    'src/components/financials/donna-financials-panel.jsx',
    'src/components/financials/alv-return-panel.jsx',
    'src/components/financials/provider-failure-panel.jsx',
    'src/components/client-book-inspection.jsx',
    'src/components/donna-client-portal.jsx'
  ]),
  sharedMountedStates: Object.freeze([
    'src/components/FirmDropOverlay.jsx',
    'src/components/UploadTray.jsx',
    'src/components/shared/toast-host.jsx',
    'src/components/shared/donna-chat.jsx',
    'src/components/documents/document-context-menu.jsx'
  ])
});

export const SUPPORTED_SURFACE_PATHS = Object.freeze(
  Object.values(SUPPORTED_SURFACE_GROUPS).flat()
);

export const SUPPORTED_SURFACE_LABS = Object.freeze({
  access: Object.freeze(['shell', 'mounted']),
  shell: Object.freeze(['shell', 'mounted']),
  settingsAndTeam: Object.freeze(['settings', 'mounted']),
  workspaces: Object.freeze(['workspaces', 'mounted']),
  sharedMountedStates: Object.freeze(['shell', 'workspaces'])
});

export const OUTSIDE_INTERFACE_LOCALE_BOUNDARY = Object.freeze([
  'src/components/marketing/**',
  'src/components/i18n/**',
  'src/components/settings/LocaleSettingsPreview.jsx'
]);

// These declarations share a mounted source module but have no production
// render site. Keeping the exception at symbol granularity prevents dormant
// prototypes from widening the supported interface by mere co-location.
export const UNMOUNTED_SOURCE_DECLARATIONS = Object.freeze([
  Object.freeze({ path: 'src/components/FirmClientWorkspace.jsx', symbols: Object.freeze(['ComplianceTab']) }),
  Object.freeze({
    path: 'src/components/financials/donna-financials-panel.jsx',
    symbols: Object.freeze([
      'FactsPanel',
      'MemoryCandidatesPanel',
      'CaseGoalSection',
      'CloseBlockersPanel',
      'ResolvedGoalsPanel',
      'GhostPicker',
      'EvidenceAuditTrail',
      'EvidenceChip',
      'CashFlowPanel',
      'CategoriesPanel',
      'RecentPanel',
      'ReconciledPanel'
    ])
  })
]);

// Visible literals that are product or fixture identity rather than
// translatable interface copy. Every allowance is exact and documented.
export const CANONICAL_VISIBLE_LITERAL_ALLOWLIST = Object.freeze([
  Object.freeze({ path: 'src/App.jsx', value: 'Donna', reason: 'Product name.' }),
  Object.freeze({ path: 'src/components/FirmAuthGate.jsx', value: 'Donna', reason: 'Product name.' }),
  Object.freeze({ path: 'src/components/FirmAuthGate.jsx', value: 'D', reason: 'Brand artwork, not interface prose.' }),
  Object.freeze({ path: 'src/components/ClientPortalGate.jsx', value: 'Donna', reason: 'Product name.' }),
  Object.freeze({ path: 'src/components/firm-dock.jsx', value: 'Donna', reason: 'Assistant product name.' }),
  Object.freeze({ path: 'src/components/settings/SettingsPanel.jsx', value: 'INV-2026-001', reason: 'Bidi identifier fixture.' }),
  Object.freeze({ path: 'src/components/settings/SettingsPanel.jsx', value: 'AE070331234567890123456', reason: 'Bidi identifier fixture.' }),
  Object.freeze({ path: 'src/components/settings/SettingsPanel.jsx', value: 'KH', reason: 'User-initials fixture.' }),
  Object.freeze({ path: 'src/components/settings/SettingsPanel.jsx', value: 'sk-…', reason: 'Provider-key prefix fixture.' }),
  Object.freeze({ path: 'src/components/settings/SettingsPanel.jsx', value: 'العربية', reason: 'Arabic language autonym.' }),
  Object.freeze({ path: 'src/components/settings/AccountingImportCard.jsx', value: '· SHA-256', reason: 'Checksum algorithm identifier.' }),
  Object.freeze({ path: 'src/components/donna-actions-panel.jsx', value: 'Donna', reason: 'Firm identity in demo correspondence.' }),
  Object.freeze({ path: 'src/components/donna-actions-panel.jsx', value: 'Kari Lehto', reason: 'Sender identity in demo correspondence.' }),
  Object.freeze({ path: 'src/components/donna-client-portal.jsx', value: 'BBVA EUR', reason: 'Canonical bank-account fixture.' }),
  Object.freeze({ path: 'src/components/donna-client-portal.jsx', value: 'Donna', reason: 'Assistant product name.' })
]);

// Exact exceptions only. These values position native desktop traffic-light
// chrome or a fixed mascot bitmap; mirroring them would break the host geometry.
export const PHYSICAL_LAYOUT_ALLOWLIST = Object.freeze([
  Object.freeze({
    path: 'src/components/DesktopTitlebar.jsx',
    symbol: 'DesktopTitlebar',
    properties: Object.freeze(['top', 'left', 'right']),
    reason: 'Native macOS titlebar and traffic-light exclusion geometry.'
  }),
  Object.freeze({
    path: 'src/components/firm-dock.jsx',
    symbol: 'BUDDY_VISOR_BOX/SVG_VISOR_BOX',
    properties: Object.freeze(['top', 'left']),
    reason: 'Fixed coordinates inside the mascot bitmap viewBox.'
  }),
  Object.freeze({
    path: 'src/components/financials/donna-financials-panel.jsx',
    symbol: 'DocumentContextMenu pointer coordinates',
    properties: Object.freeze(['clientX', 'clientY', 'rect.right', 'rect.bottom']),
    reason: 'Viewport pointer coordinates consumed by the shared popover positioner.'
  })
]);

export const OFFLINE_ARABIC_UI_FONT = Object.freeze({
  family: 'Donna Arabic UI',
  source: 'server/donna/outbound/fonts/NotoSansArabic-wdth-wght.ttf',
  license: 'server/donna/outbound/fonts/OFL.txt',
  sha256: '63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e',
  desktopBundlePattern: 'server/**/*'
});

// Electron currently exposes no native menu or notification product copy. The
// desktop title is a brand identifier. CI scans these sources so the first
// native string cannot appear without entering the catalog boundary.
export const NATIVE_PRODUCT_COPY_SOURCES = Object.freeze([
  'desktop/main.mjs',
  'desktop/preload.cjs',
  'desktop/runtime.mjs'
]);
