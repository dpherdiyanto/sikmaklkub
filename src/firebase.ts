import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  inMemoryPersistence,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  signOut,
  onAuthStateChanged,
  Auth,
  User as FirebaseUser
} from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  doc,
  getDocFromServer
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = (() => {
  try {
    return initializeFirestore(
      app,
      { experimentalAutoDetectLongPolling: true },
      firebaseConfig.firestoreDatabaseId
    );
  } catch {
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
})();
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

const PROVISIONER_APP_NAME = 'sikma-user-provisioner';

function getProvisionerAuth(): Auth {
  const existing = getApps().find((a) => a.name === PROVISIONER_APP_NAME);
  const secApp = existing || initializeApp(firebaseConfig, PROVISIONER_APP_NAME);
  try {
    return initializeAuth(secApp, { persistence: inMemoryPersistence });
  } catch {
    return getAuth(secApp);
  }
}

export function isRealFirebaseUid(uid?: string | null): boolean {
  const clean = (uid || '').trim();
  if (!clean || clean.length < 20) return false;
  if (/^(usr|user|mhs|dos|adm|plp|pbl)[-_]/i.test(clean)) return false;
  return /^[a-zA-Z0-9_-]+$/.test(clean);
}

export type ProvisionAuthResult =
  | { status: 'created' | 'matched' | 'updated'; uid: string }
  | { status: 'exists_different_password' }
  | { status: 'rate_limited'; message: string }
  | { status: 'error'; message: string };

export async function provisionUserAuthAccount(
  authEmail: string,
  rawPassword: string,
  fallbackCurrentPasswords: string[] = []
): Promise<ProvisionAuthResult> {
  const cleanEmail = authEmail.trim().toLowerCase();
  if (!cleanEmail || !rawPassword) {
    return { status: 'error', message: 'Email autentikasi dan kata sandi wajib diisi.' };
  }
  const provAuth = getProvisionerAuth();
  try {
    const cred = await createUserWithEmailAndPassword(provAuth, cleanEmail, rawPassword);
    const uid = cred.user.uid;
    await signOut(provAuth).catch(() => {});
    return { status: 'created', uid };
  } catch (createErr: unknown) {
    const code = (createErr as { code?: string })?.code || '';
    if (code === 'auth/too-many-requests') {
      await signOut(provAuth).catch(() => {});
      return {
        status: 'rate_limited',
        message: createErr instanceof Error ? createErr.message : String(createErr)
      };
    }
    if (code === 'auth/email-already-in-use') {
      try {
        const cred = await signInWithEmailAndPassword(provAuth, cleanEmail, rawPassword);
        const uid = cred.user.uid;
        await signOut(provAuth).catch(() => {});
        return { status: 'matched', uid };
      } catch (signInErr: unknown) {
        const signInCode = (signInErr as { code?: string })?.code || '';
        if (signInCode === 'auth/too-many-requests') {
          await signOut(provAuth).catch(() => {});
          return {
            status: 'rate_limited',
            message: signInErr instanceof Error ? signInErr.message : String(signInErr)
          };
        }
        if (
          signInCode === 'auth/wrong-password' ||
          signInCode === 'auth/invalid-credential' ||
          signInCode === 'auth/user-mismatch'
        ) {
          // Try known legacy/default passwords to smoothly migrate & update Firebase Auth password
          const uniqueOldPasswords = Array.from(
            new Set(fallbackCurrentPasswords.map((p) => (p || '').trim()).filter((p) => p && p !== rawPassword))
          );
          for (const oldPass of uniqueOldPasswords) {
            try {
              const cred = await signInWithEmailAndPassword(provAuth, cleanEmail, oldPass);
              await updatePassword(cred.user, rawPassword);
              const uid = cred.user.uid;
              await signOut(provAuth).catch(() => {});
              return { status: 'updated', uid };
            } catch (oldErr: unknown) {
              const oldCode = (oldErr as { code?: string })?.code || '';
              if (oldCode === 'auth/too-many-requests') {
                await signOut(provAuth).catch(() => {});
                return {
                  status: 'rate_limited',
                  message: oldErr instanceof Error ? oldErr.message : String(oldErr)
                };
              }
            }
          }
          await signOut(provAuth).catch(() => {});
          return { status: 'exists_different_password' };
        }
        await signOut(provAuth).catch(() => {});
        return {
          status: 'error',
          message: signInErr instanceof Error ? signInErr.message : String(signInErr)
        };
      }
    }
    await signOut(provAuth).catch(() => {});
    return {
      status: 'error',
      message: createErr instanceof Error ? createErr.message : String(createErr)
    };
  }
}

export async function ensureUserAuthLinked(
  authEmail: string,
  candidatePasswords: string[]
): Promise<ProvisionAuthResult> {
  const cleanEmail = authEmail.trim().toLowerCase();
  const candidates = Array.from(new Set(candidatePasswords.map((p) => (p || '').trim()).filter(Boolean)));
  if (!cleanEmail || candidates.length === 0) {
    return { status: 'error', message: 'Email autentikasi dan kandidat sandi wajib tersedia.' };
  }
  const provAuth = getProvisionerAuth();
  try {
    const cred = await createUserWithEmailAndPassword(provAuth, cleanEmail, candidates[0]);
    const uid = cred.user.uid;
    await signOut(provAuth).catch(() => {});
    return { status: 'created', uid };
  } catch (createErr: unknown) {
    const code = (createErr as { code?: string })?.code || '';
    if (code === 'auth/too-many-requests') {
      await signOut(provAuth).catch(() => {});
      return {
        status: 'rate_limited',
        message: createErr instanceof Error ? createErr.message : String(createErr)
      };
    }
    if (code === 'auth/email-already-in-use') {
      for (const pass of candidates) {
        try {
          const cred = await signInWithEmailAndPassword(provAuth, cleanEmail, pass);
          const uid = cred.user.uid;
          await signOut(provAuth).catch(() => {});
          return { status: 'matched', uid };
        } catch (signInErr: unknown) {
          const signInCode = (signInErr as { code?: string })?.code || '';
          if (signInCode === 'auth/too-many-requests') {
            await signOut(provAuth).catch(() => {});
            return {
              status: 'rate_limited',
              message: signInErr instanceof Error ? signInErr.message : String(signInErr)
            };
          }
          if (signInCode === 'auth/network-request-failed') {
            await signOut(provAuth).catch(() => {});
            return {
              status: 'error',
              message: signInErr instanceof Error ? signInErr.message : String(signInErr)
            };
          }
        }
      }
      await signOut(provAuth).catch(() => {});
      return { status: 'exists_different_password' };
    }
    await signOut(provAuth).catch(() => {});
    return {
      status: 'error',
      message: createErr instanceof Error ? createErr.message : String(createErr)
    };
  }
}

export {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  signOut,
  onAuthStateChanged,
  getApp
};
export type { FirebaseUser };

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write'
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email
        })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

void testConnection();
