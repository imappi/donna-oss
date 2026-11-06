import { D } from './design-tokens.js';

// House switch — the settings on/off control (2026-08-07). Ink track when
// on, 8% wash when off, card-white thumb: the SegmentedControl's material
// vocabulary applied to a two-state control. Replaces the old "On/Off"
// pill-button idiom on settings rows; use for real, wired state only —
// a disabled Toggle renders at half opacity and never fakes a live knob.
export const Toggle = ({ on = false, disabled = false, busy = false, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    disabled={disabled || busy}
    onClick={() => { if (!disabled && !busy) onChange?.(!on); }}
    style={{
      width: 46,
      height: 26,
      padding: 3,
      borderRadius: 999,
      border: 'none',
      flex: '0 0 auto',
      cursor: disabled ? 'default' : busy ? 'wait' : 'pointer',
      background: on ? D.ink : 'oklch(0.08 0 0 / 0.08)',
      opacity: disabled ? 0.45 : 1,
      display: 'inline-flex',
      justifyContent: on ? 'flex-end' : 'flex-start',
      transition: 'background 0.15s'
    }}
  >
    <span
      aria-hidden="true"
      style={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        background: D.card,
        boxShadow: '0 1px 2px oklch(0.08 0 0 / 0.18)'
      }}
    />
  </button>
);
