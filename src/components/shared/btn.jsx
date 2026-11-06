import { D } from './design-tokens.js';

// Button on the D palette. Primary is BLACK (Kari, 2026-07-28) and warms to the
// sunset sweep on hover — a transient, subtle use of the gradient rather than a
// painted surface. `danger` maps to D.alert, kept distinct from the accent on
// purpose: a destructive control is a genuine failure affordance, not
// decoration.
export const Btn = ({
  children,
  primary = false,
  danger = false,
  small = false,
  style = {},
  ...props
}) => (
  <button
    type="button"
    {...props}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: small ? '5px 12px' : '7px 18px',
      borderRadius: 6,
      border: primary ? 'none' : `1px solid ${danger ? D.alert : D.rule}`,
      background: primary ? D.ink : 'transparent',
      color: primary ? D.paper : danger ? D.alert : D.inkSoft,
      fontFamily: "'DM Sans', sans-serif",
      fontSize: small ? 12 : 13,
      fontWeight: 500,
      lineHeight: 1.3,
      cursor: 'pointer',
      transition: 'all 0.15s',
      ...style
    }}
    onMouseEnter={(event) => {
      if (primary) event.currentTarget.style.background = D.landingGradient;
      else if (danger) event.currentTarget.style.background = D.alertWash;
      else event.currentTarget.style.background = D.ruleSoft;
      props.onMouseEnter?.(event);
    }}
    onMouseLeave={(event) => {
      if (primary) event.currentTarget.style.background = D.ink;
      else event.currentTarget.style.background = style.background || 'transparent';
      props.onMouseLeave?.(event);
    }}
  >
    {children}
  </button>
);
