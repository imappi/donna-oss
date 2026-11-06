import { D } from './design-tokens.js';

export const Divider = ({ label }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '20px 0 12px' }}>
    <span
      style={{
        color: D.inkMute,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase'
      }}
    >
      {label}
    </span>
    <span style={{ height: 1, background: D.ruleSoft, flex: 1 }} />
  </div>
);
