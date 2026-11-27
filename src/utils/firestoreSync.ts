import {
  collection,
  deleteDoc,
  doc,
  DocumentReference,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  Unsubscribe
} from 'firebase/firestore';
import { db, ensureUserAuthLinked, FirebaseUser, handleFirestoreError, isRealFirebaseUid, OperationType } from '../firebase';
import {
  AdminStaff,
  AuthUser,
  Dosen,
  JadwalSeminar,
  LogbookLabItem,
  Mahasiswa,
  PembimbingLapanganStaff,
  PengajuanKLK,
  Pengumuman,
  PLPStaff,
  QrSosialisasiKLK,
  SuratPengajuan,
  UserRole,
  VerifiedStudentRecord,
  normalizeMahasiswaRole
} from '../types/sikma';
import { UserAccountItem } from '../data/userList';
import { createLastLoginTimestamp, parseLastLoginIso } from './lastLoginFormat';
import { getCandidateDefaultPasswords } from './syncUserAndSdm';

export const BOOTSTRAPPED_ADMIN_EMAIL = 'dp.herdiyanto@gmail.com';
export const ZUPER_ADMIN_EMAIL = 'zuperadmin@ub.ac.id';

export function isBootstrappedAdminEmail(email?: string | null, emailVerified?: boolean | null): boolean {
  const lower = (email || '').trim().toLowerCase();
  if (!lower) return false;
  if (lower === ZUPER_ADMIN_EMAIL) return true;
  return Boolean(emailVerified && lower === BOOTSTRAPPED_ADMIN_EMAIL);
}

export function usernameToAuthEmail(username: string): string {
  const raw = String(username || '').trim().toLowerCase();
  if (!raw) return 'user@sikma.ub.ac.id';
  if (raw === 'superadmin' || raw === ZUPER_ADMIN_EMAIL) return ZUPER_ADMIN_EMAIL;
  if (raw.includes('@')) return raw;
  const clean = raw.replace(/[^a-z0-9._-]/g, '').replace(/^\.+|\.+$/g, '');
  return `${clean || 'user'}@sikma.ub.ac.id`;
}

export function emailToAdminDocId(email?: string | null): string {
  const cleaned = String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_');
  return `email_${cleaned || 'unknown'}`;
}

export async function syncAdminRegistryForUser(
  user: Pick<UserAccountItem, 'email' | 'nama' | 'role' | 'status'>
): Promise<void> {
  const email = clampStr(user.email || '', 200).toLowerCase();
  if (!email || !email.includes('@')) return;
  const adminId = emailToAdminDocId(email);
  const adminRef = doc(db, 'admins', adminId);
  const isPrivileged = (user.role === 'super_admin' || user.role === 'admin') && user.status !== 'Nonaktif';

  try {
    const snap = await getDoc(adminRef);
    if (isPrivileged) {
      if (!snap.exists()) {
        await setDoc(adminRef, {
          uid: adminId,
          email,
          nama: clampStr(user.nama || 'Administrator SIKMA', 200),
          role: user.role === 'super_admin' ? 'super_admin' : 'admin',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      } else {
        await updateDoc(adminRef, {
          email,
          nama: clampStr(user.nama || 'Administrator SIKMA', 200),
          role: user.role === 'super_admin' ? 'super_admin' : 'admin',
          updatedAt: serverTimestamp()
        });
      }
    } else if (snap.exists()) {
      await deleteDoc(adminRef);
    }
  } catch (error) {
    console.warn('Sync admin registry warning:', error);
  }
}

export async function removeAdminRegistryByEmail(email?: string | null): Promise<void> {
  const lower = clampStr(email || '', 200).toLowerCase();
  if (!lower || !lower.includes('@')) return;
  const adminId = emailToAdminDocId(lower);
  try {
    await deleteDoc(doc(db, 'admins', adminId));
  } catch {
    // ignore if non-super-admin or doesn't exist
  }
}

export function sanitizeDocId(rawId: string, fallbackPrefix = 'doc'): string {
  const cleaned = String(rawId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
  if (cleaned.length >= 1) return cleaned;
  return `${fallbackPrefix}_${Date.now()}`;
}

export function clampStr(val: unknown, maxLen: number, fallback = ''): string {
  const str = typeof val === 'string' ? val.trim() : val != null ? String(val).trim() : fallback;
  return str.slice(0, maxLen);
}

export function stripUndefinedDeep<T>(value: T, depth = 0): T {
  if (depth > 14) return value;
  if (value === undefined) return null as unknown as T;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 200000) {
      // Prevent oversized base64 payloads from exceeding Firestore 1MB doc limit
      return '[Lampiran berukuran besar tersimpan lokal / gunakan tautan Google Drive]' as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .slice(0, 500)
      .map((item) => stripUndefinedDeep(item, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) {
      out[k] = stripUndefinedDeep(v, depth + 1);
    }
  }
  return out as T;
}

export async function ensureAdminRecordIfBootstrapped(firebaseUser: FirebaseUser): Promise<boolean> {
  if (!isBootstrappedAdminEmail(firebaseUser.email, firebaseUser.emailVerified)) {
    return false;
  }
  const adminRef = doc(db, 'admins', firebaseUser.uid);
  try {
    const snap = await getDoc(adminRef);
    if (!snap.exists()) {
      await setDoc(adminRef, {
        uid: sanitizeDocId(firebaseUser.uid, 'admin'),
        email: clampStr(firebaseUser.email, 200),
        nama: clampStr(firebaseUser.displayName || 'Administrator Utama SIKMA', 200),
        role: 'super_admin',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } else {
      await updateDoc(adminRef, {
        email: clampStr(firebaseUser.email, 200),
        nama: clampStr(firebaseUser.displayName || snap.data()?.nama || 'Administrator Utama SIKMA', 200),
        role: 'super_admin',
        updatedAt: serverTimestamp()
      });
    }
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `admins/${firebaseUser.uid}`);
  }
}

export async function resolveOrCreateAuthUserFromGoogle(
  firebaseUser: FirebaseUser,
  localUsers: UserAccountItem[]
): Promise<AuthUser> {
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const email = clampStr(firebaseUser.email, 200).toLowerCase();
  const isRootAdmin = isBootstrappedAdminEmail(email, firebaseUser.emailVerified);

  if (isRootAdmin) {
    await ensureAdminRecordIfBootstrapped(firebaseUser);
  }

  // 1. Check user doc keyed by uid or owned by uid (prevents duplicate doc if user doc has usr-* ID)
  const userDocRef = doc(db, 'users', uid);
  try {
    let existingSnap = await getDoc(userDocRef);
    if (!existingSnap.exists()) {
      try {
        const ownedSnap = await getDocs(query(collection(db, 'users'), where('ownerUid', '==', uid), limit(5)));
        if (!ownedSnap.empty) {
          existingSnap = ownedSnap.docs[0];
        }
      } catch {
        // ignore query error
      }
    }
    if (!existingSnap.exists() && isRootAdmin && email) {
      try {
        const emailSnap = await getDocs(query(collection(db, 'users'), where('email', '==', email), limit(5)));
        const adminDoc = emailSnap.docs.find((d) => d.data()?.role === 'super_admin') || emailSnap.docs[0];
        if (adminDoc) existingSnap = adminDoc;
      } catch {
        // ignore query error
      }
    }
    if (existingSnap.exists()) {
      const data = existingSnap.data();
      const resolvedRole: UserRole = isRootAdmin
        ? 'super_admin'
        : normalizeMahasiswaRole(data.role as string, data.unit as string);
      const nowIso = createLastLoginTimestamp();

      await updateDoc(existingSnap.ref, {
        ...(isRootAdmin && data.ownerUid !== uid ? { ownerUid: uid } : {}),
        terakhirLogin: clampStr(nowIso, 120),
        updatedAt: serverTimestamp()
      });

      return {
        id: clampStr(data.id || existingSnap.id || uid, 128),
        ownerUid: clampStr(isRootAdmin ? uid : (data.ownerUid || uid), 128),
        username: clampStr(data.username || email, 100),
        nama: clampStr(data.nama || firebaseUser.displayName || 'Pengguna SIKMA', 200),
        role: resolvedRole,
        identifier: clampStr(data.identifier || '', 100),
        email: clampStr(data.email || email, 200),
        avatarText: clampStr(
          data.avatarText || (firebaseUser.displayName || 'U').slice(0, 2).toUpperCase(),
          10
        ),
        unit: clampStr(data.unit || 'Departemen Kimia FSTeM UB', 300),
        jabatan: clampStr(data.jabatan || '', 300),
        lastLogin: 'Baru saja',
        mustChangePassword: false,
        isFirstLogin: false
      };
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `users/${uid}`);
  }

  // 2. Match against local pre-registered accounts by email (e.g. if created locally)
  const localMatch = localUsers.find(
    (u) => u.email && u.email.toLowerCase().trim() === email
  );

  // Only bootstrapped admin can self-assign super_admin; others start as mahasiswa_s1
  const assignedRole: UserRole = isRootAdmin
    ? 'super_admin'
    : 'mahasiswa_s1';

  const displayName = clampStr(
    localMatch?.nama || firebaseUser.displayName || (email.split('@')[0] || 'Pengguna UB'),
    200
  );
  const avatarText = clampStr(
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('') || 'UB',
    10
  );
  const username = clampStr(localMatch?.username || email.split('@')[0] || uid, 100);
  const identifier = clampStr(
    isRootAdmin ? 'SA-001' : localMatch?.identifier || uid.slice(0, 12).toUpperCase(),
    100
  );
  const unit = clampStr(
    isRootAdmin
      ? 'Administrator Utama Departemen Kimia FSTeM Universitas Brawijaya'
      : localMatch?.unit || 'Program Studi S1 Kimia - FSTeM Universitas Brawijaya',
    300
  );
  const jabatan = clampStr(
    isRootAdmin
      ? 'Super Administrator Sistem SIKMA'
      : localMatch?.jabatan || 'Mahasiswa Kimia UB',
    300
  );

  const nowIso = createLastLoginTimestamp();

  try {
    await setDoc(userDocRef, {
      id: uid,
      ownerUid: uid,
      username,
      nama: displayName,
      role: assignedRole,
      identifier,
      email,
      avatarText,
      unit,
      jabatan,
      status: 'Aktif',
      noHp: clampStr(localMatch?.noHp || '', 40),
      terakhirLogin: clampStr(nowIso, 120),
      mustChangePassword: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `users/${uid}`);
  }

  return {
    id: uid,
    username,
    nama: displayName,
    role: assignedRole,
    identifier,
    email,
    avatarText,
    unit,
    jabatan,
    lastLogin: 'Login Pertama Kali',
    mustChangePassword: false,
    isFirstLogin: false
  };
}

export interface RemoteSyncMeta {
  knownIds: Record<string, Set<string>>;
  ownerMap: Record<string, Record<string, string>>;
  hashes: Record<string, Record<string, string>>;
  readyCollections: Set<string>;
  deletedIds: Record<string, Set<string>>;
  syncVersions: Record<string, number>;
}

export function createEmptyRemoteSyncMeta(): RemoteSyncMeta {
  return {
    knownIds: {},
    ownerMap: {},
    hashes: {},
    readyCollections: new Set<string>(),
    deletedIds: {},
    syncVersions: {}
  };
}

export function markDocDeletedInMeta(meta: RemoteSyncMeta, colName: string, docId: string): void {
  const cleanId = sanitizeDocId(docId, 'doc');
  if (!meta.deletedIds[colName]) {
    meta.deletedIds[colName] = new Set<string>();
  }
  meta.deletedIds[colName].add(cleanId);
  meta.knownIds[colName]?.delete(cleanId);
  if (meta.hashes[colName]) {
    delete meta.hashes[colName][cleanId];
  }
}

export function clearDocDeletedInMeta(meta: RemoteSyncMeta, colName: string, docId: string): void {
  const cleanId = sanitizeDocId(docId, 'doc');
  meta.deletedIds[colName]?.delete(cleanId);
}

function stableHash(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(Date.now());
  }
}

export function buildUserDocPayload(
  item: Pick<
    UserAccountItem,
    | 'id'
    | 'username'
    | 'nama'
    | 'role'
    | 'identifier'
    | 'email'
    | 'avatarText'
    | 'unit'
    | 'jabatan'
    | 'status'
    | 'noHp'
    | 'terakhirLogin'
    | 'mustChangePassword'
    | 'passwordChangedAt'
  >,
  forcedDocId?: string
) {
  const docId = forcedDocId || sanitizeDocId(item.id, 'user');
  return {
    id: docId,
    username: clampStr(item.username || docId, 100),
    nama: clampStr(item.nama || 'Pengguna', 200),
    role: normalizeMahasiswaRole(item.role, item.unit),
    identifier: clampStr(item.identifier || '', 100),
    email: clampStr(item.email || '', 200),
    avatarText: clampStr(item.avatarText || 'UB', 10),
    unit: clampStr(item.unit || '', 300),
    jabatan: clampStr(item.jabatan || '', 300),
    status: item.status === 'Nonaktif' ? ('Nonaktif' as const) : ('Aktif' as const),
    noHp: clampStr(item.noHp || '', 40),
    terakhirLogin: clampStr(item.terakhirLogin || 'Belum pernah login', 120),
    mustChangePassword: Boolean(item.mustChangePassword),
    ...(item.passwordChangedAt ? { passwordChangedAt: clampStr(item.passwordChangedAt, 80) } : {})
  };
}

export function buildSdmSyncParts(item: Record<string, unknown>) {
  const publicCopy: Record<string, unknown> = { ...item };
  const privateEmail = clampStr(publicCopy.email || '', 200);
  const privatePhone = clampStr(publicCopy.telepon || publicCopy.noHp || '', 40);
  delete publicCopy.email;
  delete publicCopy.telepon;
  delete publicCopy.noHp;
  delete publicCopy.noHpOrangTua;
  delete publicCopy.alamat;

  const cleanPublic = stripUndefinedDeep(publicCopy);
  const syncHash = stableHash({ cleanPublic, privateEmail, privatePhone });
  return { cleanPublic, privateEmail, privatePhone, syncHash };
}

export interface SubscriptionCallbacks {
  onKlkUpdate: (items: PengajuanKLK[]) => void;
  onUsersUpdate: (items: UserAccountItem[]) => void;
  onDosenUpdate: (items: Dosen[]) => void;
  onMahasiswaUpdate: (items: Mahasiswa[]) => void;
  onAdminUpdate: (items: AdminStaff[]) => void;
  onPlpUpdate: (items: PLPStaff[]) => void;
  onPembimbingUpdate: (items: PembimbingLapanganStaff[]) => void;
  onLogbooksUpdate: (items: LogbookLabItem[]) => void;
  onSeminarsUpdate: (items: JadwalSeminar[]) => void;
  onSuratUpdate: (items: SuratPengajuan[]) => void;
  onPengumumanUpdate: (items: Pengumuman[]) => void;
  onKlkQrConfigUpdate?: (config: { qrList?: QrSosialisasiKLK[]; unblockedNims?: string[] }) => void;
  onKlkQrVerificationsUpdate?: (items: VerifiedStudentRecord[]) => void;
  onRemoteReady?: (collectionName: string, count: number) => void;
}

export function subscribeSikmaCollections(
  firebaseUser: FirebaseUser,
  role: UserRole,
  meta: RemoteSyncMeta,
  callbacks: SubscriptionCallbacks
): Unsubscribe {
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const isRootAdmin = isBootstrappedAdminEmail(firebaseUser.email, firebaseUser.emailVerified) || role === 'super_admin' || role === 'admin';
  const unsubs: Unsubscribe[] = [];

  const recordCollectionMeta = (
    colName: string,
    docs: { id: string; ownerUid?: string; payload: unknown }[]
  ) => {
    const idSet = new Set<string>();
    const owners: Record<string, string> = {};
    const hashes: Record<string, string> = {};
    for (const d of docs) {
      idSet.add(d.id);
      if (d.ownerUid) owners[d.id] = d.ownerUid;
      hashes[d.id] = stableHash(d.payload);
    }
    meta.knownIds[colName] = idSet;
    meta.ownerMap[colName] = owners;
    meta.hashes[colName] = hashes;
    meta.readyCollections.add(colName);
  };

  // 1. KLK Submissions (merge primary + DPA queries safely for dosen)
  const primaryKlkMap = new Map<string, { ownerUid?: string; item: PengajuanKLK }>();
  const dpaKlkMap = new Map<string, { ownerUid?: string; item: PengajuanKLK }>();

  const emitMergedKlk = () => {
    const mergedMap = new Map<string, { ownerUid?: string; item: PengajuanKLK }>();
    primaryKlkMap.forEach((v, k) => mergedMap.set(k, v));
    dpaKlkMap.forEach((v, k) => mergedMap.set(k, v));

    const list: PengajuanKLK[] = [];
    const metaDocs: { id: string; ownerUid?: string; payload: unknown }[] = [];
    mergedMap.forEach((entry, docId) => {
      list.push(entry.item);
      metaDocs.push({ id: docId, ownerUid: entry.ownerUid, payload: stripUndefinedDeep(entry.item) });
    });
    recordCollectionMeta('klk_submissions', metaDocs);
    callbacks.onKlkUpdate(list);
    callbacks.onRemoteReady?.('klk_submissions', list.length);
  };

  const klkQuery = isRootAdmin
    ? collection(db, 'klk_submissions')
    : role === 'dosen'
    ? query(collection(db, 'klk_submissions'), where('assignedDosenUid', '==', uid))
    : role === 'eksternal'
    ? query(collection(db, 'klk_submissions'), where('pembimbingLapanganUid', '==', uid))
    : query(collection(db, 'klk_submissions'), where('ownerUid', '==', uid));

  unsubs.push(
    onSnapshot(
      klkQuery,
      (snap) => {
        primaryKlkMap.clear();
        snap.forEach((docSnap) => {
          const raw = docSnap.data();
          if (raw && raw.data && typeof raw.data === 'object') {
            const rawData = raw.data as PengajuanKLK;
            const item: PengajuanKLK = {
              ...rawData,
              id: rawData.id || docSnap.id,
              ownerUid: clampStr(raw.ownerUid || rawData.ownerUid || '', 128) || undefined,
              assignedDosenUid: clampStr(raw.assignedDosenUid ?? rawData.assignedDosenUid ?? '', 128) || undefined,
              assignedDpaUid: clampStr(raw.assignedDpaUid ?? rawData.assignedDpaUid ?? '', 128) || undefined,
              pembimbingLapanganUid: clampStr(raw.pembimbingLapanganUid ?? rawData.pembimbingLapanganUid ?? '', 128) || undefined,
              skema: (raw.skema as PengajuanKLK['skema']) || rawData.skema,
              namaMitra: rawData.namaMitra || (raw.instansiNama as string) || '',
              status: (raw.status as PengajuanKLK['status']) || rawData.status
            };
            primaryKlkMap.set(docSnap.id, { ownerUid: raw.ownerUid as string, item });
          }
        });
        emitMergedKlk();
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'klk_submissions')
    )
  );

  if (!isRootAdmin && role === 'dosen') {
    const dpaQuery = query(collection(db, 'klk_submissions'), where('assignedDpaUid', '==', uid));
    unsubs.push(
      onSnapshot(
        dpaQuery,
        (snap) => {
          dpaKlkMap.clear();
          snap.forEach((docSnap) => {
            const raw = docSnap.data();
            if (raw && raw.data && typeof raw.data === 'object') {
              const rawData = raw.data as PengajuanKLK;
              const item: PengajuanKLK = {
                ...rawData,
                id: rawData.id || docSnap.id,
                ownerUid: clampStr(raw.ownerUid || rawData.ownerUid || '', 128) || undefined,
                assignedDosenUid: clampStr(raw.assignedDosenUid ?? rawData.assignedDosenUid ?? '', 128) || undefined,
                assignedDpaUid: clampStr(raw.assignedDpaUid ?? rawData.assignedDpaUid ?? '', 128) || undefined,
                pembimbingLapanganUid: clampStr(raw.pembimbingLapanganUid ?? rawData.pembimbingLapanganUid ?? '', 128) || undefined,
                skema: (raw.skema as PengajuanKLK['skema']) || rawData.skema,
                namaMitra: rawData.namaMitra || (raw.instansiNama as string) || '',
                status: (raw.status as PengajuanKLK['status']) || rawData.status
              };
              dpaKlkMap.set(docSnap.id, { ownerUid: raw.ownerUid as string, item });
            }
          });
          emitMergedKlk();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'klk_submissions')
      )
    );
  }

  // 2. Users (admin sees all, others see own doc)
  const usersQuery = isRootAdmin
    ? collection(db, 'users')
    : query(collection(db, 'users'), where('ownerUid', '==', uid));

  unsubs.push(
    onSnapshot(
      usersQuery,
      (snap) => {
        const list: UserAccountItem[] = [];
        const metaDocs: { id: string; ownerUid?: string; payload: unknown }[] = [];
        const deletedSet = meta.deletedIds['users'];
        const presentDocIds = new Set<string>();

        snap.forEach((docSnap) => {
          const raw = docSnap.data();
          if (raw) {
            presentDocIds.add(docSnap.id);
            if (deletedSet?.has(docSnap.id)) {
              return;
            }
            const item: UserAccountItem = {
              id: docSnap.id,
              ownerUid: clampStr(raw.ownerUid || '', 128) || undefined,
              username: clampStr(raw.username || '', 100),
              nama: clampStr(raw.nama || '', 200),
              role: normalizeMahasiswaRole(raw.role as string, raw.unit as string),
              identifier: clampStr(raw.identifier || '', 100),
              email: clampStr(raw.email || '', 200),
              avatarText: clampStr(raw.avatarText || 'UB', 10),
              unit: clampStr(raw.unit || '', 300),
              jabatan: clampStr(raw.jabatan || '', 300),
              status: raw.status === 'Nonaktif' ? 'Nonaktif' : 'Aktif',
              noHp: clampStr(raw.noHp || '', 40),
              tanggalDibuat: clampStr(raw.tanggalDibuat || '', 40) || new Date().toISOString().split('T')[0],
              terakhirLogin: clampStr(raw.terakhirLogin || 'Belum pernah login', 120),
              mustChangePassword: Boolean(raw.mustChangePassword),
              passwordChangedAt: raw.passwordChangedAt ? String(raw.passwordChangedAt) : undefined
            };
            list.push(item);
            metaDocs.push({
              id: docSnap.id,
              ownerUid: raw.ownerUid as string,
              payload: buildUserDocPayload(item, docSnap.id)
            });
          }
        });

        // Clean up deletedIds once server snapshot confirms removal
        if (deletedSet && !snap.metadata.fromCache) {
          for (const delId of Array.from(deletedSet)) {
            if (!presentDocIds.has(delId)) {
              deletedSet.delete(delId);
            }
          }
        }

        recordCollectionMeta('users', metaDocs);
        if (list.length > 0) {
          callbacks.onUsersUpdate(list);
        }
        callbacks.onRemoteReady?.('users', list.length);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'users')
    )
  );

  // 3. SDM Directory (non-PII) + optional SDM Private PII hydration for Root Admin
  const sdmDirDocs = new Map<string, { category: string; ownerUid?: string; payload: Record<string, unknown> }>();
  const sdmPrivateMap = new Map<string, { email?: string; noHp?: string }>();
  let hasDirSnapshot = false;
  let hasDirServerSnapshot = false;
  let hasPrivateSnapshot = !isRootAdmin;

  const emitSdmLists = () => {
    if (!hasDirSnapshot || !hasPrivateSnapshot) return;
    const dosen: Dosen[] = [];
    const mahasiswa: Mahasiswa[] = [];
    const admin: AdminStaff[] = [];
    const plp: PLPStaff[] = [];
    const pembimbing: PembimbingLapanganStaff[] = [];

    const byCatMeta: Record<string, { id: string; ownerUid?: string; payload: unknown }[]> = {
      dosen: [],
      mahasiswa: [],
      admin: [],
      plp: [],
      pembimbing_lapangan: []
    };

    const deletedSdmSet = meta.deletedIds['sdm_directory'];

    sdmDirDocs.forEach((entry, docId) => {
      if (deletedSdmSet?.has(docId)) return;
      const pii = isRootAdmin ? sdmPrivateMap.get(docId) : undefined;
      const cleanPublic = stripUndefinedDeep(entry.payload) as Record<string, unknown>;
      const privateEmail = clampStr(
        pii?.email || (typeof entry.payload.email === 'string' ? entry.payload.email : ''),
        200
      );
      const privatePhone = clampStr(
        pii?.noHp || (typeof entry.payload.telepon === 'string' ? entry.payload.telepon : ''),
        40
      );
      const mergedPayload: Record<string, unknown> = {
        ...cleanPublic,
        email: privateEmail,
        telepon: privatePhone
      };

      if (!byCatMeta[entry.category]) byCatMeta[entry.category] = [];
      byCatMeta[entry.category].push({
        id: docId,
        ownerUid: entry.ownerUid,
        payload: { cleanPublic, privateEmail, privatePhone }
      });

      switch (entry.category) {
        case 'dosen':
          dosen.push(mergedPayload as unknown as Dosen);
          break;
        case 'mahasiswa':
          mahasiswa.push(mergedPayload as unknown as Mahasiswa);
          break;
        case 'admin':
          admin.push(mergedPayload as unknown as AdminStaff);
          break;
        case 'plp':
          plp.push(mergedPayload as unknown as PLPStaff);
          break;
        case 'pembimbing_lapangan':
          pembimbing.push(mergedPayload as unknown as PembimbingLapanganStaff);
          break;
      }
    });

    for (const [cat, docs] of Object.entries(byCatMeta)) {
      recordCollectionMeta(`sdm_directory_${cat}`, docs);
    }
    meta.readyCollections.add('sdm_directory');

    if (sdmDirDocs.size > 0 || hasDirServerSnapshot) {
      callbacks.onDosenUpdate(dosen);
      callbacks.onMahasiswaUpdate(mahasiswa);
      callbacks.onAdminUpdate(admin);
      callbacks.onPlpUpdate(plp);
      callbacks.onPembimbingUpdate(pembimbing);
    }
    callbacks.onRemoteReady?.('sdm_directory', sdmDirDocs.size);
  };

  const sdmDirQuery = query(collection(db, 'sdm_directory'), where('isDirectoryVisible', '==', true));
  unsubs.push(
    onSnapshot(
      sdmDirQuery,
      (snap) => {
        hasDirSnapshot = true;
        if (!snap.metadata.fromCache) {
          hasDirServerSnapshot = true;
        }
        sdmDirDocs.clear();
        snap.forEach((docSnap) => {
          const raw = docSnap.data();
          if (!raw || !raw.data || typeof raw.data !== 'object') return;
          sdmDirDocs.set(docSnap.id, {
            category: String(raw.category || ''),
            ownerUid: raw.ownerUid as string,
            payload: raw.data as Record<string, unknown>
          });
        });
        if (meta.deletedIds['sdm_directory'] && !snap.metadata.fromCache) {
          for (const delId of Array.from(meta.deletedIds['sdm_directory'])) {
            if (!sdmDirDocs.has(delId)) {
              meta.deletedIds['sdm_directory'].delete(delId);
            }
          }
        }
        emitSdmLists();
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'sdm_directory')
    )
  );

  if (isRootAdmin) {
    unsubs.push(
      onSnapshot(
        collection(db, 'sdm_private'),
        (snap) => {
          hasPrivateSnapshot = true;
          sdmPrivateMap.clear();
          snap.forEach((docSnap) => {
            const raw = docSnap.data();
            if (raw) {
              sdmPrivateMap.set(docSnap.id, {
                email: typeof raw.email === 'string' ? raw.email : '',
                noHp: typeof raw.noHp === 'string' ? raw.noHp : ''
              });
            }
          });
          emitSdmLists();
        },
        (error) => {
          hasPrivateSnapshot = true;
          emitSdmLists();
          handleFirestoreError(error, OperationType.LIST, 'sdm_private');
        }
      )
    );
  }

  // 4. Lab Logbooks
  const logbookQuery = isRootAdmin
    ? collection(db, 'logbooks')
    : role === 'dosen'
    ? query(collection(db, 'logbooks'), where('assignedDosenUid', '==', uid))
    : query(collection(db, 'logbooks'), where('ownerUid', '==', uid));

  unsubs.push(
    onSnapshot(
      logbookQuery,
      (snap) => {
        const list: LogbookLabItem[] = [];
        const metaDocs: { id: string; ownerUid?: string; payload: unknown }[] = [];
        snap.forEach((docSnap) => {
          const raw = docSnap.data();
          if (raw?.data) {
            const item = raw.data as LogbookLabItem;
            list.push(item);
            metaDocs.push({ id: docSnap.id, ownerUid: raw.ownerUid as string, payload: stripUndefinedDeep(item) });
          }
        });
        recordCollectionMeta('logbooks', metaDocs);
        if (list.length > 0 || (!isRootAdmin && !snap.metadata.fromCache)) {
          callbacks.onLogbooksUpdate(list);
        }
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'logbooks')
    )
  );

  // 5. Seminars
  const seminarQuery = isRootAdmin
    ? collection(db, 'seminars')
    : query(collection(db, 'seminars'), where('isPublicSchedule', '==', true));

  unsubs.push(
    onSnapshot(
      seminarQuery,
      (snap) => {
        const list: JadwalSeminar[] = [];
        const metaDocs: { id: string; ownerUid?: string; payload: unknown }[] = [];
        snap.forEach((docSnap) => {
          const raw = docSnap.data();
          if (raw?.data) {
            const item = raw.data as JadwalSeminar;
            list.push(item);
            metaDocs.push({ id: docSnap.id, ownerUid: raw.ownerUid as string, payload: stripUndefinedDeep(item) });
          }
        });
        recordCollectionMeta('seminars', metaDocs);
        if (list.length > 0 || (!isRootAdmin && !snap.metadata.fromCache)) {
          callbacks.onSeminarsUpdate(list);
        }
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'seminars')
    )
  );

  // 6. Surat Pengajuan
  const suratQuery = isRootAdmin
    ? collection(db, 'surat_pengajuan')
    : query(collection(db, 'surat_pengajuan'), where('ownerUid', '==', uid));

  unsubs.push(
    onSnapshot(
      suratQuery,
      (snap) => {
        const list: SuratPengajuan[] = [];
        const metaDocs: { id: string; ownerUid?: string; payload: unknown }[] = [];
        snap.forEach((docSnap) => {
          const raw = docSnap.data();
          if (raw?.data) {
            const item = raw.data as SuratPengajuan;
            list.push(item);
            metaDocs.push({ id: docSnap.id, ownerUid: raw.ownerUid as string, payload: stripUndefinedDeep(item) });
          }
        });
        recordCollectionMeta('surat_pengajuan', metaDocs);
        if (list.length > 0 || (!isRootAdmin && !snap.metadata.fromCache)) {
          callbacks.onSuratUpdate(list);
        }
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'surat_pengajuan')
    )
  );

  // 7. Pengumuman
  const pengumumanQuery = isRootAdmin
    ? collection(db, 'pengumuman')
    : query(collection(db, 'pengumuman'), where('isPublicAnnouncement', '==', true));

  unsubs.push(
    onSnapshot(
      pengumumanQuery,
      (snap) => {
        const list: Pengumuman[] = [];
        const metaDocs: { id: string; ownerUid?: string; payload: unknown }[] = [];
        snap.forEach((docSnap) => {
          const raw = docSnap.data();
          if (raw?.data) {
            const item = raw.data as Pengumuman;
            list.push(item);
            metaDocs.push({ id: docSnap.id, ownerUid: raw.ownerUid as string, payload: stripUndefinedDeep(item) });
          }
        });
        recordCollectionMeta('pengumuman', metaDocs);
        if (list.length > 0) callbacks.onPengumumanUpdate(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'pengumuman')
    )
  );

  // 8. System Config: KLK QR Sosialisasi & Buka Blokir
  if (callbacks.onKlkQrConfigUpdate) {
    const qrConfigQuery = query(collection(db, 'system_configs'), where('isConfigDoc', '==', true));
    unsubs.push(
      onSnapshot(
        qrConfigQuery,
        (snap) => {
          const qrConfigDoc = snap.docs.find((d) => d.id === 'klk_qr_config');
          if (qrConfigDoc) {
            const payload = qrConfigDoc.data()?.payload;
            if (payload && typeof payload === 'object') {
              const rawQrList = Array.isArray(payload.qrList) ? (payload.qrList as QrSosialisasiKLK[]) : undefined;
              const rawUnblocked = Array.isArray(payload.unblockedNims)
                ? (payload.unblockedNims as unknown[]).map((n) => String(n || '').replace(/\D/g, '')).filter(Boolean)
                : undefined;
              callbacks.onKlkQrConfigUpdate?.({
                qrList: rawQrList,
                unblockedNims: rawUnblocked
              });
            }
          }
          callbacks.onRemoteReady?.('system_configs_klk_qr', qrConfigDoc ? 1 : 0);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'system_configs')
      )
    );
  }

  // 9. KLK QR Student Verifications
  if (callbacks.onKlkQrVerificationsUpdate) {
    const qrVerQuery = isRootAdmin
      ? collection(db, 'klk_qr_verifications')
      : query(collection(db, 'klk_qr_verifications'), where('ownerUid', '==', uid));
    unsubs.push(
      onSnapshot(
        qrVerQuery,
        (snap) => {
          const items: VerifiedStudentRecord[] = [];
          snap.forEach((docSnap) => {
            const raw = docSnap.data();
            if (raw && raw.nim) {
              items.push({
                nim: clampStr(raw.nim, 60),
                nama: clampStr(raw.nama || 'Mahasiswa', 200),
                kodeQr: clampStr(raw.kodeQr || '-', 120),
                waktuVerifikasi: typeof raw.waktuVerifikasi === 'number' ? raw.waktuVerifikasi : Date.now()
              });
            }
          });
          callbacks.onKlkQrVerificationsUpdate?.(items);
          callbacks.onRemoteReady?.('klk_qr_verifications', items.length);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'klk_qr_verifications')
      )
    );
  }

  return () => {
    unsubs.forEach((fn) => {
      try {
        fn();
      } catch {
        // ignore cleanup error
      }
    });
  };
}

const AUTH_UID_REGEX = /^[A-Za-z0-9]{20,}$/;
const SDM_UID_PREFIX_REGEX = /^(?:(?:dosen|mahasiswa|admin|plp|pembimbing_lapangan)_)?(?:dos|mhs|adm|plp|pbl)-([A-Za-z0-9]{20,})$/;

const isPlaceholderMentorName = (val?: string): boolean => {
  const norm = String(val || '').trim().toLowerCase();
  return (
    !norm ||
    norm === '-' ||
    norm === 'tbd' ||
    norm === 'pembimbing lapangan mitra terkait' ||
    norm === 'pembimbing lapangan mitra' ||
    norm.startsWith('belum ditetapkan')
  );
};

const normalizeTitleFreeName = (val?: string): string =>
  String(val || '')
    .toLowerCase()
    .replace(/\b(prof|dr|dra|drs|ir|s\.si|m\.si|m\.sc|m\.phil|ph\.d|s\.tp|m\.eng|m\.s|s\.t|m\.t|s\.pd|m\.pd|s\.ap|m\.ap|s\.kom|a\.md|s\.tr\.si|dr\.sc)\b\.?/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const isSamePersonName = (a?: string, b?: string): boolean => {
  const n1 = normalizeTitleFreeName(a);
  const n2 = normalizeTitleFreeName(b);
  if (!n1 || !n2) return false;
  if (n1 === n2) return true;
  if (n1.length >= 5 && n2.length >= 5 && (n1.includes(n2) || n2.includes(n1))) return true;
  const t1 = n1.split(' ').filter((t) => t.length >= 3);
  const t2 = n2.split(' ').filter((t) => t.length >= 3);
  if (t1.length >= 2 && t2.length >= 2) {
    const common = t1.filter((t) => t2.includes(t));
    if (common.length >= 2) return true;
  }
  return false;
};

export function extractUidFromSdmOrUser(
  entity?: { id?: string; userUid?: string; ownerUid?: string; nama?: string; email?: string; nip?: string; nidn?: string; nim?: string; idMitra?: string; username?: string } | null,
  users: UserAccountItem[] = [],
  allowedRoles?: UserRole[]
): string {
  if (!entity) return '';
  if (typeof entity.userUid === 'string' && AUTH_UID_REGEX.test(entity.userUid.trim())) {
    return entity.userUid.trim();
  }
  if (typeof entity.id === 'string') {
    const idTrim = entity.id.trim();
    const prefMatch = idTrim.match(SDM_UID_PREFIX_REGEX);
    if (prefMatch) return prefMatch[1];
    if (AUTH_UID_REGEX.test(idTrim)) return idTrim;
  }

  if (users.length > 0) {
    const eEmail = String(entity.email || '').trim().toLowerCase();
    const eNum = String(entity.nip || entity.nidn || entity.nim || entity.idMitra || '').replace(/\D/g, '');
    const eUser = String(entity.username || '').trim().toLowerCase();
    const matchedUser = users.find((u) => {
      if (allowedRoles && !allowedRoles.includes(u.role)) return false;
      if (eEmail && u.email && u.email.trim().toLowerCase() === eEmail) return true;
      const uNum = String(u.identifier || '').replace(/\D/g, '');
      if (eNum && uNum && eNum.length >= 5 && eNum === uNum) return true;
      if (eUser && u.username && u.username.trim().toLowerCase() === eUser) return true;
      if (entity.nama && u.nama && isSamePersonName(entity.nama, u.nama)) return true;
      return false;
    });
    if (matchedUser) {
      if (matchedUser.ownerUid && AUTH_UID_REGEX.test(matchedUser.ownerUid)) return matchedUser.ownerUid;
      if (AUTH_UID_REGEX.test(matchedUser.id)) return matchedUser.id;
    }
  }
  if (typeof entity.ownerUid === 'string' && AUTH_UID_REGEX.test(entity.ownerUid.trim())) {
    const ownerTrim = entity.ownerUid.trim();
    if (!allowedRoles) {
      return ownerTrim;
    }
    if (users.length > 0) {
      const ownerUser = users.find((u) => u.id === ownerTrim || u.ownerUid === ownerTrim);
      if (ownerUser && allowedRoles.includes(ownerUser.role)) {
        return ownerTrim;
      }
    }
  }
  return '';
}

async function safeGetDocState(docRef: DocumentReference): Promise<{
  exists: boolean;
  ownerUid?: string;
}> {
  try {
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      return { exists: false };
    }
    const rawOwner = snap.data()?.ownerUid;
    return {
      exists: true,
      ownerUid: typeof rawOwner === 'string' ? rawOwner : undefined
    };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || '';
    if (code === 'permission-denied') {
      return { exists: false };
    }
    throw err;
  }
}

export const isPlaceholderMitra = (raw?: string): boolean => {
  const s = (raw || '').trim().toLowerCase();
  return (
    !s ||
    s === '-' ||
    s === 'instansi / mitra industri klk' ||
    s === 'mitra industri tempat klk' ||
    s === 'instansi / perusahaan mitra'
  );
};

export const normalizeCompanyName = (raw?: string): string => {
  if (!raw || isPlaceholderMitra(raw)) return '';
  return raw
    .toLowerCase()
    .replace(/\b(pt|cv|ud|fa|tbk|persero|inc|ltd|corp|co|company|perusahaan|instansi|mitra|industri|indonesia|ind)\b\.?/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const extractEmailOrgToken = (email?: string): string => {
  const e = (email || '').trim().toLowerCase();
  const atIdx = e.indexOf('@');
  if (atIdx < 0) return '';
  const host = e.slice(atIdx + 1);
  const firstLabel = host.split('.')[0]?.replace(/[^a-z0-9]/g, '') || '';
  const genericHosts = new Set(['gmail', 'yahoo', 'ymail', 'outlook', 'hotmail', 'live', 'icloud', 'ub', 'sikma', 'mail', 'proton']);
  if (!firstLabel || firstLabel.length < 4 || genericHosts.has(firstLabel)) return '';
  return firstLabel;
};

export const areCompaniesEquivalent = (a?: string, b?: string): boolean => {
  const n1 = normalizeCompanyName(a);
  const n2 = normalizeCompanyName(b);
  if (!n1 || !n2) return false;
  if (n1 === n2) return true;
  if (n1.length >= 4 && n2.length >= 4 && (n1.includes(n2) || n2.includes(n1))) return true;
  const c1 = n1.replace(/\s+/g, '');
  const c2 = n2.replace(/\s+/g, '');
  return c1.length >= 4 && c2.length >= 4 && (c1 === c2 || c1.includes(c2) || c2.includes(c1));
};

export function enrichKlkUids(
  item: PengajuanKLK,
  ctx: {
    dosenList?: Dosen[];
    pembimbingLapanganList?: PembimbingLapanganStaff[];
    mahasiswaList?: Mahasiswa[];
    userList?: UserAccountItem[];
  }
): PengajuanKLK {
  const { dosenList = [], pembimbingLapanganList = [], mahasiswaList = [], userList = [] } = ctx;
  const studentMhs = mahasiswaList.find(
    (m) =>
      m.id === item.mahasiswaId ||
      (item.nim && m.nim && m.nim.replace(/\D/g, '') === item.nim.replace(/\D/g, '')) ||
      (item.mahasiswaNama && isSamePersonName(m.nama, item.mahasiswaNama))
  );

  let assignedDpaUid = item.assignedDpaUid || '';
  let assignedDosenUid = item.assignedDosenUid || '';
  let pembimbingLapanganUid = item.pembimbingLapanganUid || '';

  // 1. Resolve DPA UID
  const effectiveDpaId = item.dpaId || studentMhs?.dosenPAId || '';
  const effectiveDpaNama = item.dpaNama || studentMhs?.dosenPANama || '';
  const effectiveDpaNip = studentMhs?.dosenPANip || '';
  if (effectiveDpaId || effectiveDpaNama || effectiveDpaNip) {
    const matchedDpa = dosenList.find(
      (d) =>
        (effectiveDpaId && (d.id === effectiveDpaId || d.id === `dos-${effectiveDpaId}` || extractUidFromSdmOrUser(d) === effectiveDpaId)) ||
        (effectiveDpaNip && (d.nip || d.nidn || '').replace(/\D/g, '') === effectiveDpaNip.replace(/\D/g, '') && effectiveDpaNip.replace(/\D/g, '').length >= 5) ||
        (effectiveDpaNama && isSamePersonName(d.nama, effectiveDpaNama))
    );
    const resolvedDpa =
      extractUidFromSdmOrUser(matchedDpa, userList, ['dosen']) ||
      extractUidFromSdmOrUser({ id: effectiveDpaId, nama: effectiveDpaNama, nip: effectiveDpaNip }, userList, ['dosen']);
    if (resolvedDpa) {
      assignedDpaUid = resolvedDpa;
    }
  }

  // 2. Resolve Dosen Pembimbing KLK UID (ketika ditetapkan oleh Admin atau tersedia)
  const dosenKlkNama = (item.dosenPembimbingKLK || '').trim();
  if (dosenKlkNama && !dosenKlkNama.includes('Belum Ditetapkan')) {
    const matchedDosen = dosenList.find((d) => isSamePersonName(d.nama, dosenKlkNama));
    const resolvedDosen =
      extractUidFromSdmOrUser(matchedDosen, userList, ['dosen']) ||
      extractUidFromSdmOrUser({ nama: dosenKlkNama }, userList, ['dosen']);
    if (resolvedDosen) {
      assignedDosenUid = resolvedDosen;
    }
  }

  // 3. Resolve Pembimbing Lapangan / Eksternal UID
  const rawMentorName = (item.mentorIndustri || '').trim();
  const mentorName = isPlaceholderMentorName(rawMentorName) ? '' : rawMentorName;
  const mentorEmail = (item.emailMentor || '').trim().toLowerCase();
  const mentorKontak = (item.kontakMentor || '').trim().toLowerCase();
  const mitraName = (item.namaMitra || '').trim();
  const normMitra = normalizeCompanyName(mitraName);
  const compactMitra = normMitra.replace(/\s+/g, '');

  const matchedPbl = pembimbingLapanganList.find((p) => {
    const pEmail = (p.email || '').trim().toLowerCase();
    const pUsername = (p.username || '').trim().toLowerCase();
    const pIdMitra = (p.idMitra || '').trim().toLowerCase();
    if (mentorEmail && pEmail && mentorEmail === pEmail) return true;
    if (mentorEmail && pUsername && mentorEmail === pUsername) return true;
    if (mentorKontak && pEmail && mentorKontak.includes(pEmail)) return true;
    if (mentorKontak && pUsername && pUsername.length >= 4 && mentorKontak.includes(pUsername)) return true;
    if (mentorKontak && pIdMitra && pIdMitra.length >= 4 && mentorKontak.includes(pIdMitra)) return true;
    if (mentorName && p.nama && isSamePersonName(p.nama, mentorName)) return true;
    return false;
  });

  let resolvedPbl = extractUidFromSdmOrUser(matchedPbl, userList, ['eksternal']);
  if (!resolvedPbl && userList.length > 0) {
    const eksternalUser = userList.find((u) => {
      if (u.role !== 'eksternal') return false;
      const uEmail = (u.email || '').trim().toLowerCase();
      const uUser = (u.username || '').trim().toLowerCase();
      const uId = (u.identifier || '').trim().toLowerCase();
      if (mentorEmail && uEmail && mentorEmail === uEmail) return true;
      if (mentorEmail && (uUser === mentorEmail || uId === mentorEmail)) return true;
      if (mentorKontak && uEmail && mentorKontak.includes(uEmail)) return true;
      if (mentorKontak && uUser && uUser.length >= 4 && mentorKontak.includes(uUser)) return true;
      if (mentorKontak && uId && uId.length >= 4 && mentorKontak.includes(uId)) return true;
      if (mentorName && u.nama && isSamePersonName(u.nama, mentorName)) return true;
      return false;
    });
    resolvedPbl = extractUidFromSdmOrUser(eksternalUser, userList, ['eksternal']);
  }

  // Fallback by company / organization name & corporate email domain ONLY when pembimbingLapanganUid is not yet set
  if (!resolvedPbl && !pembimbingLapanganUid && normMitra) {
    const candidateUids = new Set<string>();

    for (const p of pembimbingLapanganList) {
      const pUid = extractUidFromSdmOrUser(p, userList, ['eksternal']);
      if (!pUid) continue;
      const matchingUser = userList.find(
        (u) => u.role === 'eksternal' && (u.ownerUid === pUid || u.id === pUid || (p.email && u.email?.toLowerCase() === p.email.toLowerCase()))
      );
      const effectivePblMitra = !isPlaceholderMitra(p.namaMitra) ? p.namaMitra : (matchingUser?.unit || '');
      const emailDomainToken = extractEmailOrgToken(p.email || matchingUser?.email);
      if (
        areCompaniesEquivalent(effectivePblMitra, mitraName) ||
        (emailDomainToken && compactMitra.length >= 4 && (compactMitra.includes(emailDomainToken) || emailDomainToken.includes(compactMitra)))
      ) {
        candidateUids.add(pUid);
      }
    }

    for (const u of userList) {
      if (u.role !== 'eksternal') continue;
      const uUid = extractUidFromSdmOrUser(u, userList, ['eksternal']);
      if (!uUid) continue;
      const emailDomainToken = extractEmailOrgToken(u.email);
      if (
        areCompaniesEquivalent(u.unit, mitraName) ||
        (emailDomainToken && compactMitra.length >= 4 && (compactMitra.includes(emailDomainToken) || emailDomainToken.includes(compactMitra)))
      ) {
        candidateUids.add(uUid);
      }
    }

    if (candidateUids.size === 1) {
      resolvedPbl = Array.from(candidateUids)[0];
    }
  }

  if (resolvedPbl) {
    pembimbingLapanganUid = resolvedPbl;
  }

  return {
    ...item,
    ...(assignedDpaUid ? { assignedDpaUid } : {}),
    ...(assignedDosenUid ? { assignedDosenUid } : {}),
    pembimbingLapanganUid: pembimbingLapanganUid || undefined
  };
}

export async function syncKlkListToFirestore(
  items: PengajuanKLK[],
  firebaseUser: FirebaseUser,
  meta: RemoteSyncMeta,
  allowDeletes = false,
  isAdmin = allowDeletes
): Promise<void> {
  const colName = 'klk_submissions';
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const myVersion = (meta.syncVersions[colName] = (meta.syncVersions[colName] || 0) + 1);
  const known = meta.knownIds[colName] || new Set<string>();
  const prevHashes = meta.hashes[colName] || {};
  const ownerMap = meta.ownerMap[colName] || {};
  const currentIds = new Set<string>();

  for (const item of items) {
    if (meta.syncVersions[colName] !== myVersion) return;
    const docId = sanitizeDocId(item.id, 'klk');
    currentIds.add(docId);
    const cleanData = stripUndefinedDeep(item);
    const nextHash = stableHash(cleanData);
    if (known.has(docId) && prevHashes[docId] === nextHash) {
      continue;
    }

    const docRef = doc(db, colName, docId);
    const baseFields = {
      assignedDosenUid: clampStr(item.assignedDosenUid || '', 128),
      assignedDpaUid: clampStr(item.assignedDpaUid || '', 128),
      pembimbingLapanganUid: clampStr(item.pembimbingLapanganUid || '', 128),
      mahasiswaId: clampStr(item.mahasiswaId || '', 128),
      mahasiswaNama: clampStr(item.mahasiswaNama || 'Mahasiswa', 200) || 'Mahasiswa',
      nim: clampStr(item.nim || '-', 60) || '-',
      skema: clampStr(item.skema || '', 120),
      instansiNama: clampStr(item.namaMitra || '', 250),
      status: clampStr(item.status || 'Draft', 80) || 'Draft',
      data: cleanData as unknown as Record<string, unknown>
    };

    const buildNonAdminUpdate = (existingOwnerUid?: string) => {
      const effectiveOwner = existingOwnerUid || ownerMap[docId] || item.ownerUid || '';
      if (effectiveOwner === uid) {
        return {
          skema: baseFields.skema,
          instansiNama: baseFields.instansiNama,
          status: baseFields.status,
          data: baseFields.data,
          updatedAt: serverTimestamp()
        };
      }
      return {
        status: baseFields.status,
        data: baseFields.data,
        updatedAt: serverTimestamp()
      };
    };

    try {
      if (known.has(docId)) {
        await updateDoc(
          docRef,
          isAdmin
            ? { ...baseFields, updatedAt: serverTimestamp() }
            : buildNonAdminUpdate()
        );
      } else {
        const docState = await safeGetDocState(docRef);
        if (meta.syncVersions[colName] !== myVersion) return;
        if (docState.exists) {
          await updateDoc(
            docRef,
            isAdmin
              ? { ...baseFields, updatedAt: serverTimestamp() }
              : buildNonAdminUpdate(docState.ownerUid)
          );
          if (docState.ownerUid) ownerMap[docId] = docState.ownerUid;
        } else {
          const resolvedOwner = ownerMap[docId] || uid;
          try {
            await setDoc(docRef, {
              id: docId,
              ownerUid: resolvedOwner,
              ...baseFields,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
            ownerMap[docId] = resolvedOwner;
          } catch (setErr: unknown) {
            const code = (setErr as { code?: string })?.code || '';
            if (!isAdmin && code === 'permission-denied') {
              await updateDoc(docRef, buildNonAdminUpdate());
            } else {
              throw setErr;
            }
          }
        }
        known.add(docId);
      }
      prevHashes[docId] = nextHash;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${colName}/${docId}`);
    }
  }

  if (allowDeletes) {
    for (const oldId of Array.from(known)) {
      if (meta.syncVersions[colName] !== myVersion) return;
      if (!currentIds.has(oldId)) {
        try {
          await deleteDoc(doc(db, colName, oldId));
          known.delete(oldId);
          delete prevHashes[oldId];
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `${colName}/${oldId}`);
        }
      }
    }
  }

  if (meta.syncVersions[colName] === myVersion) {
    meta.knownIds[colName] = known;
    meta.ownerMap[colName] = ownerMap;
    meta.hashes[colName] = prevHashes;
  }
}

/**
 * Mengosongkan seluruh dokumen pada koleksi `klk_submissions` di Firestore
 * secara langsung (menghindari race condition onSnapshot saat penghapusan batch).
 */
export async function clearAllKlkSubmissionsInFirestore(
  firebaseUser: FirebaseUser,
  meta: RemoteSyncMeta
): Promise<number> {
  const colName = 'klk_submissions';
  // Batalkan loop sinkronisasi KLK yang mungkin sedang berjalan
  meta.syncVersions[colName] = (meta.syncVersions[colName] || 0) + 1;

  try {
    const snap = await getDocs(collection(db, colName));
    const docRefs = snap.docs.map((d) => d.ref);
    await Promise.all(
      docRefs.map(async (ref) => {
        try {
          await deleteDoc(ref);
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `${colName}/${ref.id}`);
        }
      })
    );

    // Pastikan ID yang masih tercatat di meta lokal juga ikut terhapus bila ada
    const known = meta.knownIds[colName] || new Set<string>();
    const snapIds = new Set(snap.docs.map((d) => d.id));
    const extraIds = Array.from(known).filter((id) => !snapIds.has(id));
    await Promise.all(
      extraIds.map(async (id) => {
        try {
          await deleteDoc(doc(db, colName, id));
        } catch {
          // Abaikan jika sudah terhapus
        }
      })
    );

    meta.knownIds[colName] = new Set<string>();
    meta.ownerMap[colName] = {};
    meta.hashes[colName] = {};
    void firebaseUser;
    return docRefs.length;
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, colName);
  }
}

export async function syncUsersListToFirestore(
  items: UserAccountItem[],
  firebaseUser: FirebaseUser,
  meta: RemoteSyncMeta,
  allowDeletes = false
): Promise<void> {
  const colName = 'users';
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const isRootAdmin = isBootstrappedAdminEmail(firebaseUser.email, firebaseUser.emailVerified) || items.some((u) => u.role === 'super_admin' || u.role === 'admin');
  if (!isRootAdmin) return;

  const myVersion = (meta.syncVersions[colName] = (meta.syncVersions[colName] || 0) + 1);
  const known = meta.knownIds[colName] || new Set<string>();
  const prevHashes = meta.hashes[colName] || {};
  const ownerMap = meta.ownerMap[colName] || {};
  const deletedSet = meta.deletedIds[colName];
  const currentIds = new Set<string>();

  for (const item of items) {
    if (meta.syncVersions[colName] !== myVersion) return;
    const docId = sanitizeDocId(item.id, 'user');
    if (deletedSet?.has(docId)) {
      continue;
    }
    currentIds.add(docId);
    const cleanPayload = buildUserDocPayload(item, docId);
    const explicitRealUid = isRealFirebaseUid(item.ownerUid) ? sanitizeDocId(item.ownerUid!, 'usr') : '';
    const ownerUidForWrite = explicitRealUid || (item.ownerUid === 'unlinked-pending' ? 'unlinked-pending' : '');
    const nextHash = stableHash({ ...cleanPayload, ownerUid: ownerUidForWrite });
    if (known.has(docId) && prevHashes[docId] === nextHash) {
      continue;
    }

    const docRef = doc(db, colName, docId);
    try {
      if (known.has(docId)) {
        await updateDoc(docRef, {
          ...cleanPayload,
          ...(ownerUidForWrite ? { ownerUid: ownerUidForWrite } : {}),
          updatedAt: serverTimestamp()
        });
      } else {
        const snap = await getDoc(docRef);
        if (meta.syncVersions[colName] !== myVersion || meta.deletedIds[colName]?.has(docId)) return;
        if (snap.exists()) {
          await updateDoc(docRef, {
            ...cleanPayload,
            ...(ownerUidForWrite ? { ownerUid: ownerUidForWrite } : {}),
            updatedAt: serverTimestamp()
          });
        } else {
          const isSelfRootUser =
            cleanPayload.username.toLowerCase() === 'superadmin' ||
            cleanPayload.email.toLowerCase() === (firebaseUser.email || '').trim().toLowerCase() ||
            docId === uid;
          const resolvedOwnerUid =
            explicitRealUid ||
            (ownerMap[docId] && ownerMap[docId] !== uid ? ownerMap[docId] : '') ||
            (isSelfRootUser ? uid : docId);
          await setDoc(docRef, {
            ...cleanPayload,
            ownerUid: resolvedOwnerUid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
        known.add(docId);
      }
      prevHashes[docId] = nextHash;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${colName}/${docId}`);
    }
  }

  if (allowDeletes) {
    for (const oldId of Array.from(known)) {
      if (meta.syncVersions[colName] !== myVersion) return;
      if (!currentIds.has(oldId)) {
        try {
          markDocDeletedInMeta(meta, colName, oldId);
          await deleteDoc(doc(db, colName, oldId));
          known.delete(oldId);
          delete prevHashes[oldId];
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `${colName}/${oldId}`);
        }
      }
    }
  }

  if (meta.syncVersions[colName] === myVersion) {
    meta.knownIds[colName] = known;
    meta.hashes[colName] = prevHashes;
  }
}

export async function syncSdmCategoryToFirestore(
  category: 'dosen' | 'mahasiswa' | 'admin' | 'plp' | 'pembimbing_lapangan',
  items: Array<Record<string, unknown> & { id: string; nama: string }>,
  firebaseUser: FirebaseUser,
  meta: RemoteSyncMeta,
  allowDeletes = false,
  isAdminUser = false
): Promise<void> {
  const isRootAdmin = isAdminUser || isBootstrappedAdminEmail(firebaseUser.email, firebaseUser.emailVerified);
  if (!isRootAdmin) return;

  const colName = 'sdm_directory';
  const catMetaKey = `${colName}_${category}`;
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const myVersion = (meta.syncVersions[catMetaKey] = (meta.syncVersions[catMetaKey] || 0) + 1);
  const known = meta.knownIds[catMetaKey] || new Set<string>();
  const prevHashes = meta.hashes[catMetaKey] || {};
  const deletedSet = meta.deletedIds[colName];
  const currentIds = new Set<string>();

  for (const item of items) {
    if (meta.syncVersions[catMetaKey] !== myVersion) return;
    const docId = sanitizeDocId(`${category}_${item.id}`, 'sdm');
    if (deletedSet?.has(docId)) {
      continue;
    }
    currentIds.add(docId);

    const { cleanPublic, privateEmail, privatePhone, syncHash: nextHash } = buildSdmSyncParts(item);
    if (known.has(docId) && prevHashes[docId] === nextHash) {
      continue;
    }

    const dirPayload = {
      id: docId,
      category,
      nama: clampStr(item.nama || 'SDM Kimia UB', 200) || 'SDM Kimia UB',
      identifier: clampStr(item.nip || item.nim || item.nidn || item.id || '', 100),
      unit: clampStr(item.unit || item.lab || item.programStudi || '', 300),
      jabatan: clampStr(item.jabatan || item.jabatanAkademik || '', 300),
      status: clampStr(item.status || 'Aktif', 60),
      isDirectoryVisible: true,
      data: cleanPublic
    };

    const dirRef = doc(db, colName, docId);
    try {
      if (known.has(docId)) {
        await updateDoc(dirRef, {
          ...dirPayload,
          updatedAt: serverTimestamp()
        });
      } else {
        const snap = await getDoc(dirRef);
        if (meta.syncVersions[catMetaKey] !== myVersion || meta.deletedIds[colName]?.has(docId)) return;
        if (snap.exists()) {
          await updateDoc(dirRef, {
            ...dirPayload,
            updatedAt: serverTimestamp()
          });
        } else {
          await setDoc(dirRef, {
            ...dirPayload,
            ownerUid: uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
        known.add(docId);
      }

      // Write isolated PII into sdm_private if present
      if (privateEmail || privatePhone) {
        if (meta.syncVersions[catMetaKey] !== myVersion) return;
        const piiRef = doc(db, 'sdm_private', docId);
        const piiSnap = await getDoc(piiRef);
        if (piiSnap.exists()) {
          await updateDoc(piiRef, {
            email: privateEmail,
            noHp: privatePhone,
            updatedAt: serverTimestamp()
          });
        } else {
          await setDoc(piiRef, {
            id: docId,
            ownerUid: uid,
            email: privateEmail,
            noHp: privatePhone,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
      }
      prevHashes[docId] = nextHash;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${colName}/${docId}`);
    }
  }

  if (allowDeletes) {
    for (const oldId of Array.from(known)) {
      if (meta.syncVersions[catMetaKey] !== myVersion) return;
      if (!currentIds.has(oldId)) {
        try {
          markDocDeletedInMeta(meta, colName, oldId);
          await Promise.all([
            deleteDoc(doc(db, colName, oldId)),
            deleteDoc(doc(db, 'sdm_private', oldId)).catch(() => undefined)
          ]);
          known.delete(oldId);
          delete prevHashes[oldId];
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `${colName}/${oldId}`);
        }
      }
    }
  }

  if (meta.syncVersions[catMetaKey] === myVersion) {
    meta.knownIds[catMetaKey] = known;
    meta.hashes[catMetaKey] = prevHashes;
  }
}

export async function syncLogbooksToFirestore(
  items: LogbookLabItem[],
  firebaseUser: FirebaseUser,
  meta: RemoteSyncMeta,
  allowDeletes = false,
  isAdmin = allowDeletes
): Promise<void> {
  const colName = 'logbooks';
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const myVersion = (meta.syncVersions[colName] = (meta.syncVersions[colName] || 0) + 1);
  const known = meta.knownIds[colName] || new Set<string>();
  const prevHashes = meta.hashes[colName] || {};
  const ownerMap = meta.ownerMap[colName] || {};
  const currentIds = new Set<string>();

  for (const item of items) {
    if (meta.syncVersions[colName] !== myVersion) return;
    const docId = sanitizeDocId(item.id, 'log');
    currentIds.add(docId);
    const cleanData = stripUndefinedDeep(item);
    const nextHash = stableHash(cleanData);
    if (known.has(docId) && prevHashes[docId] === nextHash) continue;

    const payload = {
      assignedDosenUid: clampStr((item as unknown as Record<string, unknown>).assignedDosenUid || '', 128),
      mahasiswaNama: clampStr(item.mahasiswaNama || 'Mahasiswa', 200),
      nim: clampStr(item.nim || '-', 60),
      status: clampStr(item.statusVerifikasi || 'Menunggu Verifikasi', 60) || 'Menunggu Verifikasi',
      data: cleanData as unknown as Record<string, unknown>
    };
    const nonAdminUpdate = {
      status: payload.status,
      data: payload.data,
      updatedAt: serverTimestamp()
    };
    const docRef = doc(db, colName, docId);
    try {
      if (known.has(docId)) {
        await updateDoc(docRef, isAdmin ? { ...payload, updatedAt: serverTimestamp() } : nonAdminUpdate);
      } else {
        const docState = await safeGetDocState(docRef);
        if (meta.syncVersions[colName] !== myVersion) return;
        if (docState.exists) {
          await updateDoc(docRef, isAdmin ? { ...payload, updatedAt: serverTimestamp() } : nonAdminUpdate);
        } else {
          await setDoc(docRef, {
            id: docId,
            ownerUid: ownerMap[docId] || uid,
            ...payload,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
        known.add(docId);
      }
      prevHashes[docId] = nextHash;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${colName}/${docId}`);
    }
  }

  if (allowDeletes) {
    for (const oldId of Array.from(known)) {
      if (meta.syncVersions[colName] !== myVersion) return;
      if (!currentIds.has(oldId)) {
        try {
          await deleteDoc(doc(db, colName, oldId));
          known.delete(oldId);
          delete prevHashes[oldId];
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `${colName}/${oldId}`);
        }
      }
    }
  }

  if (meta.syncVersions[colName] === myVersion) {
    meta.knownIds[colName] = known;
    meta.hashes[colName] = prevHashes;
  }
}

export async function syncSeminarsToFirestore(
  items: JadwalSeminar[],
  firebaseUser: FirebaseUser,
  meta: RemoteSyncMeta,
  allowDeletes = false
): Promise<void> {
  const colName = 'seminars';
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const myVersion = (meta.syncVersions[colName] = (meta.syncVersions[colName] || 0) + 1);
  const known = meta.knownIds[colName] || new Set<string>();
  const prevHashes = meta.hashes[colName] || {};
  const ownerMap = meta.ownerMap[colName] || {};
  const currentIds = new Set<string>();

  for (const item of items) {
    if (meta.syncVersions[colName] !== myVersion) return;
    const docId = sanitizeDocId(item.id, 'sem');
    currentIds.add(docId);
    const cleanData = stripUndefinedDeep(item);
    const nextHash = stableHash(cleanData);
    if (known.has(docId) && prevHashes[docId] === nextHash) continue;

    const payload = {
      isPublicSchedule: true,
      mahasiswaNama: clampStr(item.mahasiswaNama || 'Mahasiswa', 200),
      nim: clampStr(item.nim || '-', 60),
      status: clampStr(item.status || 'Terjadwal', 60) || 'Terjadwal',
      data: cleanData as unknown as Record<string, unknown>
    };
    const docRef = doc(db, colName, docId);
    try {
      if (known.has(docId)) {
        await updateDoc(docRef, { ...payload, updatedAt: serverTimestamp() });
      } else {
        const docState = await safeGetDocState(docRef);
        if (meta.syncVersions[colName] !== myVersion) return;
        if (docState.exists) {
          await updateDoc(docRef, { ...payload, updatedAt: serverTimestamp() });
        } else {
          await setDoc(docRef, {
            id: docId,
            ownerUid: ownerMap[docId] || uid,
            ...payload,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
        known.add(docId);
      }
      prevHashes[docId] = nextHash;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${colName}/${docId}`);
    }
  }

  if (allowDeletes) {
    for (const oldId of Array.from(known)) {
      if (meta.syncVersions[colName] !== myVersion) return;
      if (!currentIds.has(oldId)) {
        try {
          await deleteDoc(doc(db, colName, oldId));
          known.delete(oldId);
          delete prevHashes[oldId];
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `${colName}/${oldId}`);
        }
      }
    }
  }

  if (meta.syncVersions[colName] === myVersion) {
    meta.knownIds[colName] = known;
    meta.hashes[colName] = prevHashes;
  }
}

export async function syncSuratListToFirestore(
  items: SuratPengajuan[],
  firebaseUser: FirebaseUser,
  meta: RemoteSyncMeta,
  allowDeletes = false
): Promise<void> {
  const colName = 'surat_pengajuan';
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const myVersion = (meta.syncVersions[colName] = (meta.syncVersions[colName] || 0) + 1);
  const known = meta.knownIds[colName] || new Set<string>();
  const prevHashes = meta.hashes[colName] || {};
  const ownerMap = meta.ownerMap[colName] || {};
  const currentIds = new Set<string>();

  for (const item of items) {
    if (meta.syncVersions[colName] !== myVersion) return;
    const docId = sanitizeDocId(item.id, 'srt');
    currentIds.add(docId);
    const cleanData = stripUndefinedDeep(item);
    const nextHash = stableHash(cleanData);
    if (known.has(docId) && prevHashes[docId] === nextHash) continue;

    const payload = {
      mahasiswaNama: clampStr(item.mahasiswaNama || 'Mahasiswa', 200),
      nim: clampStr(item.nim || '-', 60),
      jenisSurat: clampStr(item.jenis || 'Surat Akademik', 160),
      status: clampStr(item.status || 'Diajukan', 60) || 'Diajukan',
      data: cleanData as unknown as Record<string, unknown>
    };
    const docRef = doc(db, colName, docId);
    try {
      if (known.has(docId)) {
        await updateDoc(docRef, { ...payload, updatedAt: serverTimestamp() });
      } else {
        const docState = await safeGetDocState(docRef);
        if (meta.syncVersions[colName] !== myVersion) return;
        if (docState.exists) {
          await updateDoc(docRef, { ...payload, updatedAt: serverTimestamp() });
        } else {
          await setDoc(docRef, {
            id: docId,
            ownerUid: ownerMap[docId] || uid,
            ...payload,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
        known.add(docId);
      }
      prevHashes[docId] = nextHash;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${colName}/${docId}`);
    }
  }

  if (allowDeletes) {
    for (const oldId of Array.from(known)) {
      if (meta.syncVersions[colName] !== myVersion) return;
      if (!currentIds.has(oldId)) {
        try {
          await deleteDoc(doc(db, colName, oldId));
          known.delete(oldId);
          delete prevHashes[oldId];
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `${colName}/${oldId}`);
        }
      }
    }
  }

  if (meta.syncVersions[colName] === myVersion) {
    meta.knownIds[colName] = known;
    meta.hashes[colName] = prevHashes;
  }
}

export async function syncPengumumanListToFirestore(
  items: Pengumuman[],
  firebaseUser: FirebaseUser,
  meta: RemoteSyncMeta,
  allowDeletes = false,
  isAdminUser = false
): Promise<void> {
  if (!isAdminUser && !isBootstrappedAdminEmail(firebaseUser.email, firebaseUser.emailVerified)) return;
  const colName = 'pengumuman';
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const myVersion = (meta.syncVersions[colName] = (meta.syncVersions[colName] || 0) + 1);
  const known = meta.knownIds[colName] || new Set<string>();
  const prevHashes = meta.hashes[colName] || {};
  const currentIds = new Set<string>();

  for (const item of items) {
    if (meta.syncVersions[colName] !== myVersion) return;
    const docId = sanitizeDocId(item.id, 'ann');
    currentIds.add(docId);
    const cleanData = stripUndefinedDeep(item);
    const nextHash = stableHash(cleanData);
    if (known.has(docId) && prevHashes[docId] === nextHash) continue;

    const payload = {
      isPublicAnnouncement: true,
      judul: clampStr(item.judul || 'Pengumuman', 250) || 'Pengumuman',
      kategori: clampStr(item.kategori || 'Akademik', 80),
      data: cleanData as unknown as Record<string, unknown>
    };
    const docRef = doc(db, colName, docId);
    try {
      if (known.has(docId)) {
        await updateDoc(docRef, { ...payload, updatedAt: serverTimestamp() });
      } else {
        const snap = await getDoc(docRef);
        if (meta.syncVersions[colName] !== myVersion) return;
        if (snap.exists()) {
          await updateDoc(docRef, { ...payload, updatedAt: serverTimestamp() });
        } else {
          await setDoc(docRef, {
            id: docId,
            ownerUid: uid,
            ...payload,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
        known.add(docId);
      }
      prevHashes[docId] = nextHash;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${colName}/${docId}`);
    }
  }

  if (allowDeletes) {
    for (const oldId of Array.from(known)) {
      if (meta.syncVersions[colName] !== myVersion) return;
      if (!currentIds.has(oldId)) {
        try {
          await deleteDoc(doc(db, colName, oldId));
          known.delete(oldId);
          delete prevHashes[oldId];
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `${colName}/${oldId}`);
        }
      }
    }
  }

  if (meta.syncVersions[colName] === myVersion) {
    meta.knownIds[colName] = known;
    meta.hashes[colName] = prevHashes;
  }
}

export async function checkCollectionHasDocs(colName: string): Promise<boolean> {
  try {
    const snap = await getDocs(query(collection(db, colName), limit(1)));
    return !snap.empty;
  } catch {
    // Fail-safe: assume non-empty when read fails (e.g., quota/offline) to avoid re-seeding deleted records
    return true;
  }
}

export async function resolveOrCreateAuthUserFromEmailPassword(
  firebaseUser: FirebaseUser,
  matched: UserAccountItem
): Promise<AuthUser> {
  const uid = sanitizeDocId(matched.id || firebaseUser.uid, 'usr');
  const fbUid = sanitizeDocId(firebaseUser.uid, 'usr');
  const email = clampStr(matched.email || firebaseUser.email || `${matched.username}@sikma.ub.ac.id`, 200).toLowerCase();
  const isBootstrapped = isBootstrappedAdminEmail(firebaseUser.email || email, firebaseUser.emailVerified);
  const isRootAdmin = isBootstrapped || matched.role === 'super_admin';

  if (isBootstrapped) {
    await ensureAdminRecordIfBootstrapped(firebaseUser);
  }

  const userDocRef = doc(db, 'users', uid);
  const nowIso = createLastLoginTimestamp();

  const resolvedRole: UserRole = isRootAdmin ? 'super_admin' : normalizeMahasiswaRole(matched.role, matched.unit);

  try {
    const snap = await getDoc(userDocRef);
    if (!snap.exists()) {
      await setDoc(userDocRef, {
        id: uid,
        ownerUid: fbUid,
        username: clampStr(matched.username || email.split('@')[0], 100),
        nama: clampStr(matched.nama || 'Pengguna SIKMA', 200),
        role: resolvedRole,
        identifier: clampStr(matched.identifier || '', 100),
        email,
        avatarText: clampStr(matched.avatarText || 'UB', 10),
        unit: clampStr(matched.unit || 'Departemen Kimia FSTeM UB', 300),
        jabatan: clampStr(matched.jabatan || '', 300),
        status: 'Aktif',
        noHp: clampStr(matched.noHp || '', 40),
        terakhirLogin: clampStr(nowIso, 120),
        mustChangePassword: Boolean(matched.mustChangePassword),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } else {
      await updateDoc(userDocRef, {
        terakhirLogin: clampStr(nowIso, 120),
        updatedAt: serverTimestamp()
      });
    }
  } catch (error) {
    console.warn(`Resolve user doc warning (users/${uid}):`, error);
  }

  return {
    id: uid,
    ownerUid: clampStr(matched.ownerUid || fbUid, 128),
    username: clampStr(matched.username || email.split('@')[0], 100),
    nama: clampStr(matched.nama || 'Pengguna SIKMA', 200),
    role: resolvedRole,
    identifier: clampStr(matched.identifier || '', 100),
    email,
    avatarText: clampStr(matched.avatarText || 'UB', 10),
    unit: clampStr(matched.unit || 'Departemen Kimia FSTeM UB', 300),
    jabatan: clampStr(matched.jabatan || '', 300),
    lastLogin: 'Baru saja',
    mustChangePassword: Boolean(matched.mustChangePassword),
    isFirstLogin: false,
    passwordChangedAt: matched.passwordChangedAt
  };
}

/**
 * Resolves a Firebase Auth signed-in user against Firestore `users` across any PC/browser
 * (works even when localStorage on the current PC is completely empty).
 */
export async function resolveAuthenticatedUserProfile(
  firebaseUser: FirebaseUser,
  fallbackLocalUser?: UserAccountItem
): Promise<AuthUser> {
  const fbUid = sanitizeDocId(firebaseUser.uid, 'usr');
  const fbEmail = clampStr(firebaseUser.email || '', 200).toLowerCase();
  const isBootstrapped = isBootstrappedAdminEmail(fbEmail, firebaseUser.emailVerified);

  if (isBootstrapped) {
    await ensureAdminRecordIfBootstrapped(firebaseUser);
  }

  const nowIso = createLastLoginTimestamp();

  let foundDocSnap = null;

  if (isBootstrapped) {
    // 1a. For bootstrapped Super Admin, prioritize own UID doc, usr-000 (for zuperadmin), or super_admin email match
    try {
      const selfSnap = await getDoc(doc(db, 'users', fbUid));
      if (selfSnap.exists() && selfSnap.data()?.role === 'super_admin') {
        foundDocSnap = selfSnap;
      }
    } catch (err) {
      console.warn('Bootstrapped admin self doc lookup warning:', err);
    }

    if (!foundDocSnap && fbEmail === ZUPER_ADMIN_EMAIL) {
      try {
        const rootSnap = await getDoc(doc(db, 'users', 'usr-000'));
        if (rootSnap.exists()) {
          foundDocSnap = rootSnap;
        }
      } catch (err) {
        console.warn('Bootstrapped admin usr-000 lookup warning:', err);
      }
    }

    if (!foundDocSnap && fbEmail) {
      try {
        const emailSnap = await getDocs(
          query(collection(db, 'users'), where('email', '==', fbEmail), limit(5))
        );
        const preferred = emailSnap.docs.find((d) => d.data()?.role === 'super_admin') || emailSnap.docs[0];
        if (preferred) {
          foundDocSnap = preferred;
        }
      } catch (err) {
        console.warn('Bootstrapped admin email lookup warning:', err);
      }
    }

    if (!foundDocSnap) {
      try {
        const ownedSnap = await getDocs(
          query(collection(db, 'users'), where('ownerUid', '==', fbUid), limit(25))
        );
        const adminOwned = ownedSnap.docs.find(
          (d) => d.data()?.role === 'super_admin' || String(d.data()?.username || '').toLowerCase() === 'superadmin'
        );
        if (adminOwned) {
          foundDocSnap = adminOwned;
        }
      } catch (err) {
        console.warn('Bootstrapped admin ownerUid lookup warning:', err);
      }
    }
  } else {
    // 1b. Non-bootstrapped users: safe query by ownerUid == firebaseUser.uid (works for ALL roles under firestore.rules)
    try {
      const ownedSnap = await getDocs(
        query(collection(db, 'users'), where('ownerUid', '==', fbUid), limit(10))
      );
      if (!ownedSnap.empty) {
        foundDocSnap =
          ownedSnap.docs.find((d) => String(d.data()?.status || 'Aktif') === 'Aktif') ||
          ownedSnap.docs[0];
      }
    } catch (err) {
      console.warn('Query users by ownerUid warning:', err);
    }

    if (!foundDocSnap) {
      try {
        const selfDoc = await getDoc(doc(db, 'users', fbUid));
        if (selfDoc.exists()) {
          foundDocSnap = selfDoc;
        }
      } catch {
        // ignore if doc id != fbUid or permission restricted
      }
    }
  }

  if (foundDocSnap) {
    const data = foundDocSnap.data();
    const status = String(data.status || 'Aktif');
    if (status !== 'Aktif') {
      throw new Error(`USER_INACTIVE:${String(data.nama || fbEmail)}:${status}`);
    }

    const resolvedRole: UserRole = isBootstrapped
      ? 'super_admin'
      : normalizeMahasiswaRole(data.role as string, data.unit as string);

    const passwordChangedAt = data.passwordChangedAt ? String(data.passwordChangedAt) : undefined;
    const mustChangePassword = Boolean(data.mustChangePassword) && !passwordChangedAt;
    const isFirstLogin =
      !data.terakhirLogin ||
      data.terakhirLogin === 'Belum pernah login' ||
      mustChangePassword;

    // Best-effort update last login timestamp (and ensure zuperadmin root doc owns fbUid)
    try {
      await updateDoc(foundDocSnap.ref, {
        ...(isBootstrapped && fbEmail === ZUPER_ADMIN_EMAIL && data.ownerUid !== fbUid ? { ownerUid: fbUid } : {}),
        terakhirLogin: clampStr(nowIso, 120),
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      console.warn(`Update terakhirLogin warning (${foundDocSnap.id}):`, err);
    }

    return {
      id: foundDocSnap.id,
      ownerUid: clampStr(data.ownerUid || fbUid, 128),
      username: clampStr(data.username || fbEmail.split('@')[0] || fbUid, 100),
      nama: clampStr(data.nama || firebaseUser.displayName || 'Pengguna SIKMA', 200),
      role: resolvedRole,
      identifier: clampStr(data.identifier || '', 100),
      email: clampStr(data.email || fbEmail, 200),
      avatarText: clampStr(data.avatarText || 'UB', 10),
      unit: clampStr(data.unit || 'Departemen Kimia FSTeM UB', 300),
      jabatan: clampStr(data.jabatan || '', 300),
      lastLogin: isFirstLogin ? 'Login Pertama Kali' : 'Baru saja',
      mustChangePassword,
      isFirstLogin,
      passwordChangedAt
    };
  }

  // 3. If bootstrapped super admin has no Firestore user doc yet, create usr-000 / fbUid cleanly
  if (isBootstrapped) {
    const targetDocRef = doc(db, 'users', fbUid);
    const seedUsername = fallbackLocalUser?.username || (fbEmail === ZUPER_ADMIN_EMAIL ? 'superadmin' : fbEmail.split('@')[0]);
    const seedNama = clampStr(fallbackLocalUser?.nama || firebaseUser.displayName || 'Zuper Admin', 200);
    const seedIdentifier = clampStr(fallbackLocalUser?.identifier || 'SA-001', 100);
    const seedUnit = clampStr(fallbackLocalUser?.unit || 'Departemen Kimia FSTeM Universitas Brawijaya', 300);
    const seedJabatan = clampStr(fallbackLocalUser?.jabatan || 'Zuper Administrator Sistem SIKMA', 300);
    const seedAvatar = clampStr(fallbackLocalUser?.avatarText || 'ZA', 10);

    try {
      await setDoc(targetDocRef, {
        id: fbUid,
        ownerUid: fbUid,
        username: clampStr(seedUsername, 100),
        nama: seedNama,
        role: 'super_admin',
        identifier: seedIdentifier,
        email: fbEmail,
        avatarText: seedAvatar,
        unit: seedUnit,
        jabatan: seedJabatan,
        status: 'Aktif',
        noHp: clampStr(fallbackLocalUser?.noHp || '', 40),
        terakhirLogin: clampStr(nowIso, 120),
        mustChangePassword: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      console.warn('Bootstrap superadmin doc warning:', err);
    }

    return {
      id: fbUid,
      username: seedUsername,
      nama: seedNama,
      role: 'super_admin',
      identifier: seedIdentifier,
      email: fbEmail,
      avatarText: seedAvatar,
      unit: seedUnit,
      jabatan: seedJabatan,
      lastLogin: 'Baru saja',
      mustChangePassword: false,
      isFirstLogin: false
    };
  }

  // 4. Non-bootstrapped user with NO matching Firestore `users` document -> reject (deleted/unregistered)
  throw new Error('USER_NOT_FOUND_IN_FIRESTORE');
}

/**
 * Memperbarui `terakhirLogin` pada Firestore ketika pengguna yang sudah login
 * membuka ulang aplikasi / menyegarkan sesi (throttle minimal 5 menit).
 */
export async function touchUserLastLoginInFirestore(
  firebaseUser: FirebaseUser,
  userDocId?: string,
  currentTerakhirLogin?: string
): Promise<string | null> {
  const parsed = parseLastLoginIso(currentTerakhirLogin);
  if (parsed && Date.now() - parsed.getTime() < 5 * 60 * 1000) {
    return null;
  }

  const fbUid = sanitizeDocId(firebaseUser.uid, 'usr');
  const candidateId = userDocId ? sanitizeDocId(userDocId, 'usr') : fbUid;
  const nowIso = createLastLoginTimestamp();

  try {
    const directRef = doc(db, 'users', candidateId);
    const directSnap = await getDoc(directRef);
    if (directSnap.exists()) {
      const existingParsed = parseLastLoginIso(String(directSnap.data()?.terakhirLogin || ''));
      if (existingParsed && Date.now() - existingParsed.getTime() < 5 * 60 * 1000) {
        return null;
      }
      await updateDoc(directRef, {
        terakhirLogin: clampStr(nowIso, 120),
        updatedAt: serverTimestamp()
      });
      return nowIso;
    }

    const ownedSnap = await getDocs(
      query(collection(db, 'users'), where('ownerUid', '==', fbUid), limit(1))
    );
    if (!ownedSnap.empty) {
      const docSnap = ownedSnap.docs[0];
      const existingParsed = parseLastLoginIso(String(docSnap.data()?.terakhirLogin || ''));
      if (existingParsed && Date.now() - existingParsed.getTime() < 5 * 60 * 1000) {
        return null;
      }
      await updateDoc(docSnap.ref, {
        terakhirLogin: clampStr(nowIso, 120),
        updatedAt: serverTimestamp()
      });
      return nowIso;
    }
  } catch (err) {
    console.warn('Touch terakhirLogin warning:', err);
  }
  return null;
}

export async function syncKlkQrConfigToFirestore(
  qrList: QrSosialisasiKLK[],
  unblockedNims: string[],
  firebaseUser: FirebaseUser
): Promise<void> {
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const docId = 'klk_qr_config';
  const docRef = doc(db, 'system_configs', docId);
  const cleanQrList = stripUndefinedDeep(qrList).slice(0, 200);
  const cleanUnblockedNims = Array.from(
    new Set(unblockedNims.map((n) => String(n || '').replace(/\D/g, '')).filter(Boolean))
  ).slice(0, 1000);
  const payloadData = {
    qrList: cleanQrList as unknown as Record<string, unknown>[],
    unblockedNims: cleanUnblockedNims
  };

  try {
    const docState = await safeGetDocState(docRef);
    if (docState.exists) {
      await updateDoc(docRef, {
        isConfigDoc: true,
        payload: payloadData,
        updatedAt: serverTimestamp()
      });
    } else {
      await setDoc(docRef, {
        id: docId,
        ownerUid: uid,
        isConfigDoc: true,
        payload: payloadData,
        updatedAt: serverTimestamp()
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `system_configs/${docId}`);
  }
}

export async function saveStudentQrVerificationToFirestore(
  record: VerifiedStudentRecord,
  firebaseUser: FirebaseUser
): Promise<void> {
  const uid = sanitizeDocId(firebaseUser.uid, 'usr');
  const cleanNim = String(record.nim || '').replace(/\D/g, '') || uid;
  const docId = sanitizeDocId(`qrver_${cleanNim}`, 'qrver');
  const docRef = doc(db, 'klk_qr_verifications', docId);
  const fields = {
    nim: clampStr(cleanNim, 60) || uid,
    nama: clampStr(record.nama || 'Mahasiswa', 200) || 'Mahasiswa',
    kodeQr: clampStr(record.kodeQr || '-', 120) || '-',
    waktuVerifikasi: Math.round(Number(record.waktuVerifikasi) || Date.now())
  };

  try {
    const docState = await safeGetDocState(docRef);
    if (docState.exists) {
      await updateDoc(docRef, {
        ...fields,
        updatedAt: serverTimestamp()
      });
    } else {
      await setDoc(docRef, {
        id: docId,
        ownerUid: uid,
        ...fields,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `klk_qr_verifications/${docId}`);
  }
}

export async function deleteStudentQrVerificationInFirestore(nim: string): Promise<void> {
  const cleanNim = String(nim || '').replace(/\D/g, '');
  if (!cleanNim) return;
  const docId = sanitizeDocId(`qrver_${cleanNim}`, 'qrver');
  try {
    await deleteDoc(doc(db, 'klk_qr_verifications', docId));
  } catch {
    // ignore if missing
  }
  try {
    const snap = await getDocs(
      query(collection(db, 'klk_qr_verifications'), where('nim', '==', cleanNim))
    );
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => undefined)));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `klk_qr_verifications/${docId}`);
  }
}

export async function clearAllKlkQrVerificationsInFirestore(): Promise<void> {
  try {
    const snap = await getDocs(collection(db, 'klk_qr_verifications'));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, 'klk_qr_verifications');
  }
}

export interface BatchAuthProvisionSummary {
  updatedUsers: UserAccountItem[];
  linkedCount: number;
  createdCount: number;
  conflictUsernames: string[];
  rateLimitedUsernames: string[];
  errorCount: number;
}

export interface BatchAuthProvisionProgress {
  processed: number;
  total: number;
  linkedCount: number;
  createdCount: number;
  conflictCount: number;
  rateLimitedCount: number;
  errorCount: number;
  currentUsername?: string;
  waitingCooldown?: boolean;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Memastikan setiap akun aktif pada daftar `users` sudah memiliki akun login Firebase Auth
 * (`<username>@sikma.ub.ac.id`) dan dokumen Firestore `users/{docId}` menautkan `ownerUid` asli.
 * Bersifat non-destruktif: tidak menimpa kata sandi kustom milik pengguna yang sudah ada,
 * serta dilengkapi jeda permintaan dan coba ulang otomatis saat terkena rate-limit Auth.
 */
export async function provisionAndLinkUsersBatch(
  users: UserAccountItem[],
  firebaseUser: FirebaseUser | null,
  options?: {
    onlyUnlinked?: boolean;
    includeSuperAdmin?: boolean;
    onProgress?: (progress: BatchAuthProvisionProgress) => void;
  }
): Promise<BatchAuthProvisionSummary> {
  const onlyUnlinked = options?.onlyUnlinked ?? true;
  const includeSuperAdmin = options?.includeSuperAdmin ?? false;
  const onProgress = options?.onProgress;
  let linkedCount = 0;
  let createdCount = 0;
  let errorCount = 0;
  const conflictUsernames: string[] = [];
  const rateLimitedUsernames: string[] = [];

  if (!firebaseUser || !Array.isArray(users) || users.length === 0) {
    return { updatedUsers: users, linkedCount, createdCount, conflictUsernames, rateLimitedUsernames, errorCount };
  }

  const nextUsers = [...users];
  const targetIndices: number[] = [];
  const seenBatchUsernames = new Set<string>();

  for (let i = 0; i < nextUsers.length; i++) {
    const u = nextUsers[i];
    if (!u || typeof u !== 'object') continue;
    if (u.status !== 'Aktif') continue;
    if (!includeSuperAdmin && u.role === 'super_admin' && (u.username || '').toLowerCase() === 'superadmin') {
      continue;
    }
    if (onlyUnlinked && isRealFirebaseUid(u.ownerUid)) {
      continue;
    }
    const uname = (u.username || '').trim();
    if (!uname) continue;
    const unameLower = uname.toLowerCase();
    if (seenBatchUsernames.has(unameLower)) continue;
    seenBatchUsernames.add(unameLower);
    targetIndices.push(i);
  }

  const total = targetIndices.length;
  const paceDelayMs = total > 20 ? 180 : total > 5 ? 110 : 0;

  onProgress?.({
    processed: 0,
    total,
    linkedCount,
    createdCount,
    conflictCount: 0,
    rateLimitedCount: 0,
    errorCount
  });

  for (let idxPos = 0; idxPos < targetIndices.length; idxPos++) {
    const i = targetIndices[idxPos];
    const u = nextUsers[i];
    const uname = (u.username || '').trim();

    if (idxPos > 0 && paceDelayMs > 0) {
      await sleepMs(paceDelayMs);
    }

    const authEmail =
      u.role === 'super_admin' && uname.toLowerCase() === 'superadmin'
        ? ZUPER_ADMIN_EMAIL
        : usernameToAuthEmail(uname);

    const candidatePasswords = getCandidateDefaultPasswords(u.role, u.jabatan, u.password);
    let provRes = await ensureUserAuthLinked(authEmail, candidatePasswords);

    // Retry with progressive cooldown if Firebase Auth throttles requests
    for (let retry = 0; retry < 2 && provRes.status === 'rate_limited'; retry++) {
      onProgress?.({
        processed: idxPos,
        total,
        linkedCount,
        createdCount,
        conflictCount: conflictUsernames.length,
        rateLimitedCount: rateLimitedUsernames.length,
        errorCount,
        currentUsername: uname,
        waitingCooldown: true
      });
      await sleepMs((retry + 1) * 3000);
      provRes = await ensureUserAuthLinked(authEmail, candidatePasswords);
    }

    if (provRes.status === 'created' || provRes.status === 'matched' || provRes.status === 'updated') {
      const realUid = sanitizeDocId(provRes.uid, 'user');
      const docId = sanitizeDocId(u.id, 'user');

      nextUsers[i] = {
        ...u,
        ownerUid: realUid
      };

      if (provRes.status === 'created') createdCount++;
      linkedCount++;

      try {
        const userRef = doc(db, 'users', docId);
        const snap = await getDoc(userRef);
        const payload = buildUserDocPayload({ ...u, id: docId }, docId);
        if (snap.exists()) {
          await updateDoc(userRef, {
            ...payload,
            ownerUid: realUid,
            updatedAt: serverTimestamp()
          });
        } else {
          await setDoc(userRef, {
            ...payload,
            ownerUid: realUid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
      } catch (err) {
        console.warn(`Link ownerUid warning for ${docId}:`, err);
      }
    } else if (provRes.status === 'exists_different_password') {
      conflictUsernames.push(uname);
    } else if (provRes.status === 'rate_limited') {
      rateLimitedUsernames.push(uname);
      errorCount++;
    } else {
      errorCount++;
    }

    onProgress?.({
      processed: idxPos + 1,
      total,
      linkedCount,
      createdCount,
      conflictCount: conflictUsernames.length,
      rateLimitedCount: rateLimitedUsernames.length,
      errorCount,
      currentUsername: uname,
      waitingCooldown: false
    });
  }

  return {
    updatedUsers: nextUsers,
    linkedCount,
    createdCount,
    conflictUsernames,
    rateLimitedUsernames,
    errorCount
  };
}
