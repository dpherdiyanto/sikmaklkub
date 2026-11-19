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

export type ProvisionAuthResult =
  | { status: 'created' | 'matched'; uid: string }
  | { status: 'exists_different_password' }
  | { status: 'error'; message: string };

export async function provisionUserAuthAccount(
  authEmail: string,
  rawPassword: string
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
    if (code === 'auth/email-already-in-use') {
      try {
        const cred = await signInWithEmailAndPassword(provAuth, cleanEmail, rawPassword);
        const uid = cred.user.uid;
        await signOut(provAuth).catch(() => {});
        return { status: 'matched', uid };
      } catch (signInErr: unknown) {
        await signOut(provAuth).catch(() => {});
        const signInCode = (signInErr as { code?: string })?.code || '';
        if (
          signInCode === 'auth/wrong-password' ||
          signInCode === 'auth/invalid-credential' ||
          signInCode === 'auth/user-mismatch'
        ) {
          return { status: 'exists_different_password' };
        }
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
