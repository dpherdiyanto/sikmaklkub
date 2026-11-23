export interface FormattedLastLogin {
  label: string;
  title: string;
  isToday: boolean;
  isYesterday: boolean;
  isNever: boolean;
  isLegacy: boolean;
}

const SHORT_MONTHS_ID = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Mei',
  'Jun',
  'Jul',
  'Agu',
  'Sep',
  'Okt',
  'Nov',
  'Des'
];

const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}(?:T|\s)/;

interface JakartaParts {
  year: number;
  month: number;
  day: number;
  hour: string;
  minute: string;
  second: string;
}

function getJakartaParts(date: Date): JakartaParts {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value || '00';

  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: pick('hour') === '24' ? '00' : pick('hour'),
    minute: pick('minute'),
    second: pick('second')
  };
}

function toDayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * Menghasilkan timestamp ISO-8601 UTC yang disimpan ke Firestore pada kolom `terakhirLogin`.
 * Panjang 24 karakter (aman di bawah batas 120 karakter pada aturan Firestore).
 */
export function createLastLoginTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * Mengurai nilai `terakhirLogin` menjadi Date bila berupa ISO-8601 yang valid.
 */
export function parseLastLoginIso(rawValue?: string | null): Date | null {
  const trimmed = (rawValue || '').trim();
  if (!trimmed || !ISO_DATE_PREFIX_RE.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Memformat `terakhirLogin` secara dinamis berdasarkan tanggal kalender WIB (Asia/Jakarta)
 * terhadap waktu saat ini (`nowDate`), sehingga login kemarin otomatis tampil sebagai "Kemarin"
 * dan login lebih lama tampil dengan tanggal kalender lengkap.
 */
export function formatTerakhirLogin(
  rawValue?: string | null,
  nowDate: Date = new Date()
): FormattedLastLogin {
  const trimmed = (rawValue || '').trim();

  if (!trimmed || trimmed === '-' || trimmed.toLowerCase() === 'belum pernah login') {
    return {
      label: 'Belum pernah login',
      title: 'Pengguna belum pernah masuk ke sistem SIKMA',
      isToday: false,
      isYesterday: false,
      isNever: true,
      isLegacy: false
    };
  }

  if (trimmed === 'Baru saja' || trimmed === 'Login Pertama Kali') {
    return {
      label: trimmed,
      title: trimmed,
      isToday: true,
      isYesterday: false,
      isNever: false,
      isLegacy: false
    };
  }

  const parsed = parseLastLoginIso(trimmed);
  if (parsed) {
    const loginParts = getJakartaParts(parsed);
    const nowParts = getJakartaParts(nowDate);
    const dayDiff =
      toDayNumber(nowParts.year, nowParts.month, nowParts.day) -
      toDayNumber(loginParts.year, loginParts.month, loginParts.day);

    const monthName = SHORT_MONTHS_ID[Math.max(0, Math.min(11, loginParts.month - 1))] || '';
    const timeLabel = `${loginParts.hour}.${loginParts.minute} WIB`;
    const fullDateTime = `${loginParts.day} ${monthName} ${loginParts.year}, ${loginParts.hour}.${loginParts.minute}.${loginParts.second} WIB`;

    if (dayDiff === 0) {
      return {
        label: `Hari ini, ${timeLabel}`,
        title: `Login terakhir: ${fullDateTime}`,
        isToday: true,
        isYesterday: false,
        isNever: false,
        isLegacy: false
      };
    }

    if (dayDiff === 1) {
      return {
        label: `Kemarin, ${timeLabel}`,
        title: `Login terakhir: ${fullDateTime}`,
        isToday: false,
        isYesterday: true,
        isNever: false,
        isLegacy: false
      };
    }

    return {
      label: `${loginParts.day} ${monthName} ${loginParts.year}, ${timeLabel}`,
      title: `Login terakhir: ${fullDateTime}`,
      isToday: false,
      isYesterday: false,
      isNever: false,
      isLegacy: false
    };
  }

  // Fallback aman untuk data lama yang masih berupa string statis ("Hari ini, 12.32 WIB", dll.)
  if (/^hari ini,/i.test(trimmed)) {
    const timePart = trimmed.replace(/^hari ini,\s*/i, '').trim();
    return {
      label: timePart ? `Sebelumnya (${timePart})` : 'Sebelumnya',
      title:
        'Catatan login versi lama tanpa tanggal kalender. Akan otomatis menampilkan tanggal akurat saat pengguna masuk kembali.',
      isToday: false,
      isYesterday: false,
      isNever: false,
      isLegacy: true
    };
  }

  return {
    label: trimmed,
    title: 'Catatan login versi lama. Akan diperbarui otomatis dengan tanggal penuh saat pengguna masuk kembali.',
    isToday: false,
    isYesterday: false,
    isNever: false,
    isLegacy: true
  };
}
