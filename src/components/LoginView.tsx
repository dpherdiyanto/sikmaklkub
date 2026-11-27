import React, { useState } from 'react';
import { UserRole, AuthUser, normalizeMahasiswaRole } from '../types/sikma';
import { UserAccountItem, INITIAL_USER_ACCOUNTS, NIM_NIP_MIGRATION_FLAG, migrateUsernamesToNimNip } from '../data/userList';
import { UbLogo } from './UbLogo';
import { verifyPassword, isHashedPassword } from '../utils/passwordPolicy';
import { auth, googleProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from '../firebase';
import {
  resolveOrCreateAuthUserFromGoogle,
  resolveAuthenticatedUserProfile,
  usernameToAuthEmail,
  ZUPER_ADMIN_EMAIL
} from '../utils/firestoreSync';
import { createLastLoginTimestamp } from '../utils/lastLoginFormat';
import {
  FlaskConical,
  User,
  Lock,
  Eye,
  EyeOff,
  LogIn,
  Calendar,
  AlertCircle
} from 'lucide-react';

interface LoginViewProps {
  onLoginSuccess: (user: AuthUser) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState<boolean>(false);

  // Only read accounts actually cached in this browser's localStorage (do NOT treat INITIAL_USER_ACCOUNTS as authoritative)
  const getSavedLocalAccounts = (): UserAccountItem[] => {
    try {
      const saved = localStorage.getItem('sikma_user_accounts');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          let changed = false;
          const normalized = parsed.map((acc) => {
            const raw = String(acc.role || '').trim().toLowerCase();
            return {
              ...acc,
              role:
                raw === 'super_admin' || raw === 'super admin' || raw === 'superadmin'
                  ? ('super_admin' as UserRole)
                  : normalizeMahasiswaRole(acc.role, acc.unit || acc.jabatan)
            };
          });
          let finalAccounts = normalized;
          if (!localStorage.getItem(NIM_NIP_MIGRATION_FLAG)) {
            const migRes = migrateUsernamesToNimNip(normalized);
            finalAccounts = migRes.migrated;
            localStorage.setItem(NIM_NIP_MIGRATION_FLAG, 'true');
            if (migRes.changed) changed = true;
          }
          if (changed) {
            localStorage.setItem('sikma_user_accounts', JSON.stringify(finalAccounts));
          }
          return finalAccounts;
        }
      }
    } catch {
      // ignore local parse fallback
    }
    return [];
  };

  const handleGoogleLogin = async () => {
    setErrorMessage('');
    setIsGoogleLoading(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const accounts = getSavedLocalAccounts();
      const authUser = await resolveOrCreateAuthUserFromGoogle(result.user, accounts);
      onLoginSuccess(authUser);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('popup-closed-by-user')) {
        setErrorMessage('Login Google dibatalkan sebelum selesai.');
      } else if (msg.includes('popup-blocked')) {
        setErrorMessage('Popup login Google diblokir oleh browser. Silakan izinkan popup untuk situs ini.');
      } else {
        setErrorMessage('Gagal masuk menggunakan akun Google. Silakan coba lagi.');
      }
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');

    const inputUser = username.trim();
    const inputPass = password.trim();

    if (!inputUser || !inputPass) {
      setErrorMessage('Silakan masukkan Username (NIM / NIP) dan Kata Sandi.');
      return;
    }

    setIsLoading(true);

    setTimeout(async () => {
      try {
        const localAccounts = getSavedLocalAccounts();
        const inputLower = inputUser.toLowerCase();
        const cleanInput = inputLower.replace(/[^a-z0-9]/g, '');

        // Optional local cache match (helps identify legacy PC-local accounts or pre-login inactive status)
        const localMatched = localAccounts.find((acc) => {
          if (!acc) return false;
          const u = (acc.username || '').toLowerCase();
          const idLower = (acc.identifier || '').toLowerCase();
          const emailLower = (acc.email || '').toLowerCase();
          const cleanId = idLower.replace(/[^a-z0-9]/g, '');
          return (
            (u && u === inputLower) ||
            (idLower && idLower === inputLower) ||
            (cleanInput.length >= 4 && cleanId.includes(cleanInput)) ||
            (emailLower && emailLower === inputLower)
          );
        });

        if (localMatched && localMatched.status !== 'Aktif') {
          setErrorMessage(
            `Akun "${localMatched.nama}" sedang berstatus ${localMatched.status}. Silakan hubungi Administrator SIKMA.`
          );
          return;
        }

        // Build Firebase Auth email candidates deterministically so ANY PC can authenticate without localStorage
        const candidateEmails: string[] = [];
        const pushCandidate = (emailVal?: string) => {
          const clean = (emailVal || '').trim().toLowerCase();
          if (clean && clean.includes('@') && !candidateEmails.includes(clean)) {
            candidateEmails.push(clean);
          }
        };

        const isSuperAdminAttempt =
          inputLower === 'superadmin' || inputLower === ZUPER_ADMIN_EMAIL;

        if (isSuperAdminAttempt) {
          pushCandidate(ZUPER_ADMIN_EMAIL);
        } else if (inputLower.includes('@')) {
          pushCandidate(inputLower);
          const localPart = inputLower.split('@')[0]?.trim();
          if (localPart) {
            pushCandidate(usernameToAuthEmail(localPart));
          }
        } else {
          // Strip common NIP./NIM. prefixes if user typed e.g. "NIP. 1974..." into username box
          const strippedNumericId = inputLower.replace(/^(nip|nim)\s*\.?\s*/i, '').trim();
          const pureDigits = strippedNumericId.replace(/\D/g, '');
          pushCandidate(usernameToAuthEmail(strippedNumericId || inputLower));
          if (pureDigits.length >= 5) {
            pushCandidate(usernameToAuthEmail(pureDigits));
          }
          if (strippedNumericId !== inputLower) {
            pushCandidate(usernameToAuthEmail(inputLower));
          }
          if (localMatched?.username) {
            pushCandidate(usernameToAuthEmail(localMatched.username));
          }
          if (localMatched?.email) {
            pushCandidate(localMatched.email);
          }
        }

        let fbUser = null;
        let lastAuthErrorCode = '';

        for (const candidateEmail of candidateEmails) {
          try {
            const cred = await signInWithEmailAndPassword(auth, candidateEmail, inputPass);
            fbUser = cred.user;
            break;
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code || '';
            lastAuthErrorCode = code;
            if (code === 'auth/network-request-failed' || code === 'auth/too-many-requests') {
              break;
            }
          }
        }

        // Bootstrap only for root superadmin first-time setup or legacy PC-local verified account
        if (
          !fbUser &&
          (lastAuthErrorCode === 'auth/user-not-found' ||
            lastAuthErrorCode === 'auth/invalid-credential' ||
            lastAuthErrorCode === 'auth/wrong-password')
        ) {
          if (isSuperAdminAttempt && inputPass === (INITIAL_USER_ACCOUNTS[0]?.password || 'Super@123')) {
            try {
              const cred = await createUserWithEmailAndPassword(auth, ZUPER_ADMIN_EMAIL, inputPass);
              fbUser = cred.user;
            } catch {
              // Fall through to wrong-password/not-found handling
            }
          } else if (localMatched) {
            const storedPass = localMatched.password;
            const isStoredHashed = isHashedPassword(storedPass);
            const isHashVerified = storedPass ? await verifyPassword(inputPass, storedPass) : false;
            const isLocalPasswordValid = isHashVerified || (!isStoredHashed && storedPass === inputPass);
            if (isLocalPasswordValid) {
              try {
                const cred = await createUserWithEmailAndPassword(
                  auth,
                  usernameToAuthEmail(localMatched.username || inputUser),
                  inputPass
                );
                fbUser = cred.user;
              } catch {
                // If email-already-in-use, Firebase Auth already has a newer/different password
              }
            }
          }
        }

        if (!fbUser) {
          if (lastAuthErrorCode === 'auth/network-request-failed') {
            setErrorMessage(
              'Gagal terhubung ke server autentikasi Firebase. Silakan periksa koneksi internet Anda.'
            );
          } else if (lastAuthErrorCode === 'auth/too-many-requests') {
            setErrorMessage(
              'Terlalu banyak percobaan login gagal. Silakan tunggu beberapa saat sebelum mencoba lagi.'
            );
          } else {
            setErrorMessage(
              `Login gagal untuk "${username}". Pastikan Username (NIM / NIP / ID Mitra) atau Email dan Kata Sandi benar serta akun telah terdaftar pada Konfigurasi Pengguna SIKMA.`
            );
          }
          return;
        }

        // Resolve profile authoritatively from Firestore (works across PCs with empty localStorage)
        let authUser: AuthUser;
        try {
          authUser = await resolveAuthenticatedUserProfile(fbUser, localMatched);
        } catch (profileErr: unknown) {
          const msg = profileErr instanceof Error ? profileErr.message : String(profileErr);
          await signOut(auth).catch(() => {});

          if (msg.startsWith('USER_INACTIVE:')) {
            const parts = msg.split(':');
            const nama = parts[1] || username;
            const status = parts[2] || 'Nonaktif';
            setErrorMessage(
              `Akun "${nama}" sedang berstatus ${status}. Silakan hubungi Administrator SIKMA.`
            );
          } else if (msg === 'USER_NOT_FOUND_IN_FIRESTORE') {
            setErrorMessage(
              `Akun "${username}" tidak ditemukan atau belum disinkronkan di server Firestore. Pastikan akun telah dibuat/disimpan ulang oleh Admin pada menu Config → User.`
            );
          } else {
            setErrorMessage(`Gagal memuat profil pengguna dari server: ${msg}`);
          }
          return;
        }

        // Refresh last login timestamp in localStorage cache if already present
        if (localMatched && localStorage.getItem('sikma_user_accounts')) {
          const nowIso = createLastLoginTimestamp();
          const updatedAccounts = localAccounts.map((item) =>
            item.id === localMatched.id
              ? { ...item, terakhirLogin: nowIso, mustChangePassword: authUser.mustChangePassword }
              : item
          );
          localStorage.setItem('sikma_user_accounts', JSON.stringify(updatedAccounts));
        }

        onLoginSuccess(authUser);
      } finally {
        setIsLoading(false);
      }
    }, 250);
  };


  return (
    <div className="min-h-screen bg-slate-100 flex flex-col justify-between">
      {/* Top Banner Bar */}
      <header className="bg-[#002B49] text-white border-b-4 border-[#D4AF37] shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 drop-shadow-md">
              <UbLogo className="w-10 h-10" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-lg font-bold tracking-tight text-white">
                  SIKMA KLK <span className="text-[#D4AF37]">KIMIA</span> UB
                </span>
                <span className="text-[10px] uppercase font-bold bg-[#D4AF37] text-[#002B49] px-1.5 py-0.5 rounded">
                  FSTeM
                </span>
              </div>
              <p className="text-[11px] text-slate-300 hidden sm:block">
                Sistem Informasi Kegiatan Mahasiswa & Akademik Kimia Universitas Brawijaya
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-3 text-xs text-slate-300">
            <span className="hidden md:inline-flex items-center">
              <Calendar className="w-3.5 h-3.5 mr-1 text-[#D4AF37]" />
              Semester Ganjil 2026/2027
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-500/40">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse"></span>
              Server Aktif
            </span>
          </div>
        </div>
      </header>

      {/* Main Login Body */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6 lg:p-8">
        <div className="w-full max-w-md mx-auto">
          {/* Interactive Login Box */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
              {/* Header Box with Role Gradient */}
              <div className="bg-[#002B49] text-white p-6 relative overflow-hidden">
                <div className="absolute right-0 bottom-0 opacity-10 translate-x-4 translate-y-4">
                  <FlaskConical className="w-36 h-36 text-white" />
                </div>
                <div className="relative z-10 flex items-center justify-between">
                  <div>
                    <h3 className="text-xl font-bold text-white">
                      Masuk ke Akun Anda
                    </h3>
                  </div>
                </div>
              </div>

              {/* Login Form */}
              <div className="p-6 sm:p-8 space-y-6">
                {errorMessage && (
                  <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center space-x-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 text-rose-600" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                <form onSubmit={handleSubmit} autoComplete="off" className="space-y-4">
                  {/* Username Input */}
                  <div>
                    <label
                      htmlFor="login-username-input"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Username (NIM / NIP / ID Mitra)
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                        <User className="w-4 h-4" />
                      </div>
                      <input
                        type="text"
                        id="login-username-input"
                        name="sikma_username"
                        autoComplete="off"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Masukkan Username / NIM / NIP..."
                        required
                        className="w-full pl-9 pr-3 py-2.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002B49] focus:border-[#002B49] transition-all"
                      />
                    </div>
                  </div>

                  {/* Password Input */}
                  <div>
                    <label
                      htmlFor="login-password-input"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Kata Sandi (Password)
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                        <Lock className="w-4 h-4" />
                      </div>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        id="login-password-input"
                        name="sikma_password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Masukkan kata sandi..."
                        required
                        className="w-full pl-9 pr-10 py-2.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002B49] focus:border-[#002B49] transition-all"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>


                  {/* Submit Button */}
                  <button
                    type="submit"
                    id="submit-login-btn"
                    disabled={isLoading || isGoogleLoading}
                    className="w-full py-3 px-4 rounded-xl text-xs font-bold text-white bg-[#002B49] hover:bg-[#001D33] active:scale-[0.99] transition-all shadow-md flex items-center justify-center space-x-2 border border-slate-800 disabled:opacity-75 cursor-pointer"
                  >
                    {isLoading ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    ) : (
                      <>
                        <LogIn className="w-4 h-4 text-[#D4AF37]" />
                        <span>Login</span>
                      </>
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
      </main>

      {/* Footer */}
      <footer className="bg-[#001D33] text-slate-400 text-xs py-4 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-center sm:text-left">
          <div>
            <span className="text-slate-300 font-semibold">
              SIKMA Kimia FSTeM Universitas Brawijaya
            </span>{' '}
            © {new Date().getFullYear()} - Hak Cipta Dilindungi
          </div>
          <div className="text-[11px] text-slate-400">
            Gedung Jurusan Kimia, Jl. Veteran Malang 65145, Jawa Timur, Indonesia
          </div>
        </div>
      </footer>
    </div>
  );
};
