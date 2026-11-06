import { D } from './design-tokens.js';

export const Pill = ({ children, color = D.inkSoft, bg = D.ruleSoft, style = {} }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 10px',
      borderRadius: 9999,
      background: bg,
      color,
      fontSize: 11,
      fontWeight: 500,
      lineHeight: 1.3,
      whiteSpace: 'nowrap',
      maxWidth: 140,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      ...style
    }}
  >
    {children}
  </span>
);
