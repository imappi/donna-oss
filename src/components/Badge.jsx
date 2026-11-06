export const Badge = ({ variant = '', className = '', children }) => (
  <span className={`badge ${variant} ${className}`.trim()}>{children}</span>
);

export const RiskBadge = ({ level, firmMode = false }) => {
  const map = firmMode
    ? {
        low: { label: 'Routine', cls: 'green' },
        medium: { label: 'Review needed', cls: 'amber' },
        high: { label: 'Needs judgment', cls: 'red' }
      }
    : {
        low: { label: 'Low risk', cls: 'green' },
        medium: { label: 'Review', cls: 'amber' },
        high: { label: 'High risk', cls: 'red' }
      };
  const { label, cls } = map[level] || map.medium;
  return <Badge variant={cls}>{label}</Badge>;
};
