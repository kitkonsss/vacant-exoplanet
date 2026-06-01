import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
    return twMerge(clsx(inputs));
}

export function fmtNumber(value, decimals = 0) {
    if (value == null || !Number.isFinite(value)) return '—';
    return value.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

export function fmtStrike(value) {
    if (value == null || !Number.isFinite(value)) return '—';
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Format an ISO timestamp (any tz, our data is UTC) as Thailand / Bangkok local time.
 * Forces Gregorian calendar so the year stays 2026 (Thai locale defaults to the
 * Buddhist era). Returns the raw input if it isn't a parseable date.
 * @param {string|null|undefined} iso
 * @param {{ withTz?: boolean }} [opts]
 */
export function fmtBangkok(iso, { withTz = true } = {}) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const s = new Intl.DateTimeFormat('th-TH-u-ca-gregory', {
        timeZone: 'Asia/Bangkok',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(d);
    return withTz ? `${s} น. (เวลาไทย)` : s;
}

export function fmtK(n) {
    if (!n || n === 0) return '';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
}

/**
 * Map "tone" to Tailwind text/bg classes.
 * @param {'up'|'down'|'muted'|'call'|'put'|'warn'|'mag'} tone
 */
export function toneClasses(tone) {
    switch (tone) {
        case 'up':   return { text: 'text-up',   bg: 'bg-up/10',   border: 'border-up/30',   ring: 'ring-up/30' };
        case 'down': return { text: 'text-down', bg: 'bg-down/10', border: 'border-down/30', ring: 'ring-down/30' };
        case 'call': return { text: 'text-call', bg: 'bg-call/10', border: 'border-call/30', ring: 'ring-call/30' };
        case 'put':  return { text: 'text-put',  bg: 'bg-put/10',  border: 'border-put/30',  ring: 'ring-put/30' };
        case 'warn': return { text: 'text-warn', bg: 'bg-warn/10', border: 'border-warn/30', ring: 'ring-warn/30' };
        case 'mag':  return { text: 'text-mag',  bg: 'bg-mag/10',  border: 'border-mag/30',  ring: 'ring-mag/30' };
        default:     return { text: 'text-muted-foreground', bg: 'bg-muted/40', border: 'border-border', ring: 'ring-border' };
    }
}
