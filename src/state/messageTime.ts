/** Message timestamps are milliseconds; labels follow the viewer's local calendar day. */
export function messageTime(timestamp: number | undefined, now = Date.now()) {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp), today = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(today.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  const sameYear = date.getFullYear() === today.getFullYear();
  const sameDay = sameYear && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const prefix = sameDay ? '' : `${sameYear ? '' : `${date.getFullYear()}-`}${pad(date.getMonth() + 1)}-${pad(date.getDate())} `;
  return {label: prefix + clock, iso: date.toISOString(), full: date.toLocaleString('zh-CN')};
}
