import { D } from './design-tokens.js';

export const Block = ({ label, children, style = {} }) => (
  <div style={{ marginBottom: 12, ...style }}>
    <div
      style={{
        marginBottom: 6,
        color: D.inkMute,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase'
      }}
    >
      {label}
    </div>
    {children}
  </div>
);
