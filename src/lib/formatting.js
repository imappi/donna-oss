export const formatTimeAgo = (timestamp, nowValue = Date.now()) => {
  const diffMs = Math.max(0, nowValue - timestamp);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

export const formatPercent = (value) => `${Math.round(value * 100)}%`;

export const isSameDay = (timestamp, reference) => {
  const date = new Date(timestamp);
  const ref = new Date(reference);
  return (
    date.getFullYear() === ref.getFullYear() &&
    date.getMonth() === ref.getMonth() &&
    date.getDate() === ref.getDate()
  );
};
