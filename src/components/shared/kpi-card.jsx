import { D } from './design-tokens.js';

// KPI tile on the D palette. Note the deliberate colour removal: D's rule for
// financial surfaces is that AMOUNTS STAY INK (negatives render in
// parentheses) and the warm accent is never an alarm, so the value no longer
// renders green-when-positive. The `positive` prop is kept because callers
// pass it and the sign is still carried by the trend text itself — it just no
// longer drives colour. An explicit `color` override still wins.
export const KpiCard = ({ label, value, sub, trend, positive, color }) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      padding: '18px 20px',
      border: `1px solid ${D.ruleSoft}`,
      borderRadius: 10,
      background: D.card
    }}
  >
    <div style={{ fontSize: 12, color: D.inkMute, fontWeight: 500, marginBottom: 6 }}>{label}</div>
    <div
      style={{
        fontFamily: D.mono,
        fontSize: 16,
        fontWeight: 600,
        color: color || D.ink,
        lineHeight: 1.35
      }}
    >
      {value}
    </div>
    {sub && (
      <div style={{ fontSize: 12, color: D.inkMute, marginTop: 5 }}>
        {trend && <strong style={{ color: D.ink, fontWeight: 600 }}>{trend} </strong>}
        {sub}
      </div>
    )}
  </div>
);
